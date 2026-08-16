---
title: "0126 — Plugin Subsystem Governance"
description: "Settles who plugins are for, how far their code is trusted, and how a capability that nothing consumes is resolved — so that what the subsystem advertises and what it enforces stop diverging."
---

# ADR 0126 — Plugin Subsystem Governance

**Status:** Accepted
**Rollout:** Not started — the decisions below are the accepted contract; none of
the repairs they authorise have landed yet.
**Date:** 2026-08-15

## Context

The plugin subsystem is large and, structurally, in good shape. All 51
`create*API` factories are assembled into the runtime context by
`createFullPluginContext`. All 57 canonical extension points have a live JSX
mount, held there by `pnpm audit:slots`. 41 of 49 first-party plugins are
registered, and the 8 that are not are each accounted for — five in an
`INTENTIONALLY_UNBUNDLED` allowlist with a written reason, three loaded through
the Tauri host rather than the browser bundle. There are parity gates for the
permission catalogue, the Rust capability set and the SDK helpers.

The defects are not in the API layer or the slot layer. They cluster in four
places, and they share one root cause.

**The subsystem advertises more than it enforces.** `native:filesystem` and
`native:process` appear in `permission-guard.ts` only as a group label and a
description string; nothing reads them — and `cognia-sandboxed-tools` ships a
manifest asking the user to consent to both. `configSchema.secret` is validated
in `validation.ts`, and its type documentation promises the value is stored in
the OS keyring and read back through `ctx.configuration.getSecret()`; that
method does not exist, the form renders a plain input, and the value lands in
the plaintext config store. Twenty-three lifecycle hooks ship dispatchers with
zero emit sites. `manifest.dexie.migrations` is typed, validated and
SDK-exported, and `runPendingMigrations` has a full test suite and no
production caller.

**Some gates cannot fail.** `contract-path-audit.ts` exists to close the
"contract cites a file that does not exist" hole, but it walks only
`PLUGIN_CAPABILITY_CONTRACTS` — `RUNTIME_POINT_BINDINGS` holds five paths that
are not on disk, including one pointing at a directory as though it were a
file. Worse than the phantom paths: `workflow.task` and `modal.mount` are
genuinely implemented, yet sit in `KNOWN_DORMANT_RUNTIME_POINTS`, so the
reachability gate skips them permanently and a real regression there cannot be
caught. `RUNTIME_RISK_AUDITS` — the ledger built to track exactly this class of
risk — is an empty array.

**Registered is not the same as reachable.** Plugin-contributed skills, MCP
server presets and density presets land in working registries that no
user-facing surface reads; every skill picker in the app queries Dexie instead.
Nine browser-blocked and eleven mobile-blocked built-ins are listed as ordinary
enable-able rows, and the only feedback is a generic error toast after the
click — the manager's own comment says blocked plugins stay "visible in
`/plugins` (flagged incompatible)", and the flag was never built.

**One capability is disconnected from itself.** The VS Code reuse layer has
roughly 880 lines of webview, terminal and document plumbing that is
implemented, tested, and has its UI halves mounted in production — while 68 RPC
methods sit in an explicitly-unavailable list whose handler throws. The layer
has no ADR; the plan file that authorised it is gone from disk; and the
subsystem docs describe it as working, down to a live "Doc pool | 50 models"
statistic.

The shared root cause is that there was never an answer on record to *who
plugins are for*. Without it, an API that no first-party plugin calls is
ambiguous — dead weight, or a promise to an author who has not arrived yet —
and every such judgement was deferred rather than made.

## Decision

### Third-party plugin authors are a real audience

The evidence for this is already in the repository and was not written by
accident: signed backward-compatibility fixtures under
`packages/plugin-sdk/contract/compat/`, an `api-surface-baseline.json`, and
four hash-pinned VS Code 1.128 parity files with structured exclusion codes.
Nobody builds those for a purely internal module boundary.

The strongest counter-evidence — `@cognia/plugin-sdk` imports around 390 `@/`
application paths and cannot build standalone, which is why it is absent from
`pnpm build:packages` — is **debt, not a statement of intent**. It is the
concrete thing standing between an external author and an installable SDK, and
it is now tracked as such.

The direct consequence, and the reason this decision comes first: **an API with
zero first-party consumption is not automatically dead.** It may be a promise
to someone who has not arrived. That distinction is what the dormancy rule
below exists to make.

### Plugin code is semi-trusted, and the boundary is the import graph

Three postures were available. Full trust — external code with the host's own
privileges, gated only by review — is what ships today, and it does not survive
contact with a third-party audience. Full isolation in a Worker, iframe or WASM
sandbox would end frontend plugins' ability to contribute React components, and
UI slots, message renderers and context panels are among the most-used
contribution kinds; that price is too high for the whole fleet.

**Semi-trusted** is the middle: plugin code stays in the renderer's context,
but its capability surface is closed. Deep `@/lib/*` imports into host
internals are banned; a plugin reaches the host through `ctx.*` and the SDK, and
the permission gate is meaningful because it is the only door.

This is enforceable today rather than aspirational —
`lib/plugin/security/import-boundary.ts` already implements
`findHostPrivateImports` and `assertNoHostPrivateImports`. It has simply never
been turned on.

### The boundary is frozen, then repaid per import path

First-party plugins violate the boundary heavily; `workflow-ai` alone has 27
deep imports. Migrating all 41 registered plugins before enabling the gate would
block every other repair in this ADR behind a large refactor, and enforcing the
rule only against external plugins would mean the first-party fleet is not a
usable example of what an external author can write — the SDK's real usability
would never be tested by anyone who could fix it.

So the existing violations are frozen into an allowlist and the gate blocks only
new ones. The allowlist is keyed **per import path**, not per plugin: a
plugin-level exemption lets that plugin add unlimited new violations, which
makes the gate decorative. Per-path entries also make the list double as the
requirements document for the SDK surface — each line records which host module
a plugin needed and what SDK capability would remove the need. The debt is paid
down one deleted line at a time.

### Permissions split three ways, and the consent sheet says which is which

The interesting number is not that the manifest accepts 110 canonical
permissions while `ctx.permissions.requestPermission` accepts 44. It is that a
handful of permissions gate nothing at all, and the user is asked to consent to
them anyway.

Forcing a runtime check onto all 110 would be noise —
`lib/plugin/api/media-api.ts` explains, correctly, that `media:image:read` has
no host resource to protect. Narrowing the manifest to 44 would break existing
manifests and ignores that some permissions are enforced across the Rust
boundary rather than in the API layer. The honest fix is classification:

- **`api-gated`** — checked at the API call through `hasApiOrGuardPermission`.
- **`bridge-enforced`** — checked by the bridge when a contribution registers.
- **`declarative-only`** — metadata. Disclosed at install, never intercepted.

The class is encoded in the type, so a parity test can assert that every
permission belongs to exactly one and that every `api-gated` one has a real call
site.

The install consent sheet then **partitions** rather than hides. Dropping
`declarative-only` entries would lose real information — the user still wants to
know a plugin intends to touch images. Listing them undifferentiated alongside
enforced permissions is precisely the false promise this ADR is closing. Two
labelled groups keep both properties.

### Plugin hooks are observers unless separately authorised

The 23 dormant hooks are about to gain emit sites on session creation, message
mutation, scheduled-task firing and workflow node registration. If those
dispatches were synchronous and interceptable, a single slow or throwing plugin
could block session creation.

Hooks are therefore fire-and-forget: asynchronous, non-blocking, and isolated
so a throwing handler cannot break the host path. Interception is not removed —
it keeps running through the existing `CHAT_INTERCEPT_HOOKS` mechanism, which is
already gated by the `hooks:chat-intercept` permission, so the ability to alter
host behaviour stays something a user consents to rather than something every
hook implicitly carries.

### Dormant capability is resolved by evidence, defaulting to wiring it up

| Verdict | Condition | Action |
|---|---|---|
| Keep | Consumed by ≥1 registered first-party plugin | No change |
| Keep (external promise) | Zero first-party consumption, but present in `api-surface-baseline.json`, an SDK `define*` factory, or the contract catalogue | Keep, **and** add a fixture-plugin call proving it works |
| Downgrade claim | Implemented, but the producer is explicitly disabled | Change the declared `status`, return an explicit unsupported error, stop advertising `implemented` |
| Intentionally dormant | Zero consumption, but ADR-backed or an author template / E2E fixture | Three-axis labelling: typed as dormant, inert in the UI, pinned by a test |
| Delete | Zero consumption, not in any contract, no ADR backing, superseded by another implementation | Remove |

The default is to wire a capability up, not to remove it. Deletion is reserved
for genuine duplicates — `core/wasm-runtime.ts`, superseded by
`core/wasm-loader.ts`, is the shape that qualifies.

The fixture requirement on the second row is the load-bearing part. An API that
is promised externally but has never been executed is **more** dangerous than a
dead one: its first execution happens in an external author's hands, where a
failure is a support burden instead of a test failure. The existing
`ui-surface-reference` plugin is the working precedent for an E2E-only fixture;
API-contract conformance gets a sibling rather than being folded into it.

### A gate that cannot fail is not a gate

Three defects share one shape, and the repair does too. `contract-path-audit`
must walk `RUNTIME_POINT_BINDINGS` and the docs constants, not only the
capability contracts. `KNOWN_DORMANT_RUNTIME_POINTS` must not contain points
that are implemented — an exemption list that swallows working code converts a
regression detector into a blind spot.

And `RUNTIME_RISK_AUDITS` entries carry an `owner` and a `dueDate`, with the
gate failing on an expired unaddressed entry. The ledger's current state — a
correct mechanism, built, and never populated — is the exact failure this ADR
is about; without an expiry it will return to being empty and nobody will
notice.

### The VS Code reuse layer gets its own declared water level

Two subsystems are easily confused and are not the same. The
`code-1.128-*.json` contract files govern **Cognia plugins projected into VS
Code** — the managed IDE platform — and are hash-pinned, generator-checked and
CI-gated. The reuse layer runs real VSIX extensions **into Cognia**, the
opposite direction, and shares no code with them.

That layer's entire compatibility statement is
`EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS`: a hand-maintained array with no
upstream provenance, no digest and no generator. Wiring methods against it just
shortens an unaudited list, and leaves no way to answer the question an external
author asks first — which extensions actually run.

So a sibling contract is generated from the same pinned `vscode.d.ts`,
classifying every dispatcher method as supported or excluded with a reason code,
gated the same way. This is a precondition for wiring, not a follow-up.

### Capability ownership is written down, not gated

Five extension mechanisms coexist and their capabilities overlap. The boundary
is recorded as guidance so that "should this be a plugin or a skill?" has a
documented answer, but it is deliberately **not** enforced by a test: these
boundaries will move, and pinning them now would block reasonable adjustments
for no safety gain.

| Mechanism | Owns | Because |
|---|---|---|
| Plugin | Anything needing a host API, a UI contribution, a lifecycle, or a permission | It is the only mechanism with `ctx.*`, React contributions and a consent model |
| Skill | Prompt-level procedure and domain knowledge, no code execution | It shapes model behaviour; giving it host access would duplicate the plugin permission model |
| Hook | Automation at a lifecycle cut point | It adds no new capability surface — it observes or intercepts one that exists |
| MCP server | Tools provided by a separate process, reusable outside this app | The process boundary is the point; in-process tools belong to plugins |
| Slash command | — | Not a peer. It is an invocation surface for the other four |

The last row is a finding, not a definition. Slash commands were being weighed
as a fifth place to put a capability; they are a way to reach one.

## Consequences

- Turning on the import boundary produces a long allowlist — a hundred-plus
  entries is likely. That list is uncomfortable to look at and is the point:
  it is the first honest measurement of how far the SDK is from being
  sufficient. Progress is legible as lines removed.
- Classifying a permission as `declarative-only` is a public admission that it
  does not protect anything. That is the intended effect. If a permission
  deserves enforcement, the classification exercise is where that gets decided,
  not deferred again.
- Observer-only hooks mean plugins cannot veto session deletion or block a
  scheduled task. Should a real case for interception appear, it goes through
  the permissioned interception path — the answer is not to make all hooks
  blocking.
- The dormancy rule's bias toward wiring means the subsystem's maintenance
  surface grows rather than shrinks, and each wired capability brings the
  repository's ≥90% changed-file coverage requirement with it. This is accepted
  deliberately: a capability the project keeps but does not connect costs the
  same maintenance and delivers nothing.
- Declaring a VS Code water level will classify a substantial number of methods
  as excluded. Naming what is not supported is worth more than an implicit
  claim of full compatibility that no extension can rely on.
- `@cognia/plugin-sdk` is not made standalone-buildable by this ADR. It is
  measured and stratified into type-only and real value dependencies, with the
  type-only half extracted. Until the residual reaches zero, third-party
  authorship remains a stated target rather than a working one — and that gap
  is now recorded rather than implicit.
