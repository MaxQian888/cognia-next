---
title: "0087 — Python-Backed Plugin Contributions"
description: "Makes the capability contract tell the truth about what Python can execute, and routes module-bridge contributions into the plugin's Python subprocess through one shared seam."
---

# ADR 0087 — Python-Backed Plugin Contributions

**Status:** Accepted
**Date:** 2026-07-21

## Context

The Python plugin runtime (`crates/cognia-plugin-runtime/src/python/`) has shipped
for a while: a subprocess per plugin, NDJSON over stdio, an embedded `host.py`,
venv management, and a `cognia-plugin-sdk` authoring package. `tools`, `hooks`
and `configuration` genuinely execute there.

Everything else was a half-truth. An audit of the plugin surface found a hard
line running through the capability set that nothing in the codebase named:

- **Declarative capabilities** (`skills`, `subagent`, `character-pack`,
  `theme-pack`, `pet-item`, `workflow-template`, …) are plain JSON in the
  manifest. The host consumes them without caring what language wrote them, so
  Python already worked.
- **Module-bridge capabilities** (`ocrProviders`, `aiProviders`, `connectors`,
  `workspaceBackends`, …) resolve to a **live JS object with methods** —
  `provider.extract(...)`, `backend.clone(...)`, `adapter.send(...)`. Each
  bridge dynamic-imports a JS `entry` and calls a named `export`. A pure-Python
  plugin cannot hand back a JS object.
- **UI capabilities** (`views`/tree-view, `messageRenderers`, `modalMounts`,
  `contextPanels`) need React components in the renderer. A subprocess has no
  DOM.

The dishonesty was not in the runtime — it was encoded in the contract and the
SDK. `plugin-sdk/python` shipped `define_ocr_provider()`, `define_connector()`
and friends, so a Python author could write what looked like a working
provider; `define_connector` even took a `factory: str` naming a JS symbol that
could not exist. `PluginCapabilityContract.pythonSdk` listed Python SDK files
for capabilities Python could never execute, and the proof audit *required*
that field for every `supported` capability — so the contract actively pushed
every capability to claim Python support. Meanwhile `cognia plugin lint`
rejected such a plugin outright with
`manifest.contributions.javascript.unsupported_for_python`, leaving the author
with an SDK that invited code the linter refused.

## Decision

Two changes, in this order.

### 1. Make the contract state Python executability

`packages/plugin-sdk/contract/catalog.json` already classified every
contribution's `execution` (`host` / `javascript` / `conditional` / …). We did
**not** add a parallel table; we added one axis to the same records:

```
manifestContributions[].pythonExecution: "supported" | "experimental" | "unsupported"
```

Absent means `"unsupported"`. It is only meaningful for `javascript` /
`conditional` fields — `host` contributions are data and language-agnostic. The
axis flows through `scripts/plugin/generate-contract.mjs` into both mirrors
(`crates/cognia-cli/src/engine/contract.rs`, `_generated_contract.py`), so the
Rust linter and the Python SDK self-check agree by construction.

`capabilityPythonExecution()` in `lib/plugin/contracts/plugin-capabilities.ts`
derives per-capability truth from those records, and the proof audit now demands
`pythonSdk` only where Python can actually own the capability.

### 2. Route execution through one shared seam

`lib/plugin/bridge/_shared/python-backed-proxy.ts` builds the live object each
bridge expects, with every method round-tripping through the existing
`plugin_python_call` RPC. No new Rust command, no new wire method.

**Backend resolution** (identical in three places, kept in lockstep —
`effectiveContributionBackend` in `validation.ts`,
`isPythonBackedContribution` in the seam, and the Rust lint):

1. an explicit per-entry `backend: "js" | "python"`;
2. a declared JS module path (`entry`) — writing one *is* the declaration of JS
   intent, so it is never silently ignored;
3. the plugin type (`python` → `"python"`, everything else → `"js"`).

Rule 2 exists because the first draft defaulted a `type: "python"` plugin's
contributions to Python unconditionally, which would have silently discarded an
`entry` the author had written.

**Streaming** correlates on a seam-generated `streamId`, not the protocol's
`call_id`: that id is assigned inside the Rust NDJSON layer and never reaches
the renderer. Python emits `chunk {streamId, value}` / `chunk_end {streamId}`.

**Inbound push** reuses the `plugin:python` event channel. `cognia.emit(id,
channel, payload)` produces an `emit` frame that
`subscribePythonContributionPush` delivers to the owning bridge.

**Authoring** is one decorator; `describe()` returns the plain-data descriptor a
JS factory would have returned inline:

```python
@cognia.contribution("tesseract")
class Tesseract:
    def describe(self):
        return {"label": "Tesseract", "category": "local", "credentialKeys": []}

    def extract(self, image, ctx=None):
        return {...}
```

## Capability tiers

| Tier | Capabilities | `pythonExecution` |
| --- | --- | --- |
| Request/response executors | `media` (ocr), `ai-provider`, `workspace-backend`, `routing-strategy`, `deployment-filter`, `context-provider`, `session-importer`, `protocol-adapter`, `external-agent-adapter` | `supported` |
| Awkward executors | `connectors`, `chat-middleware`, `terminal-completion` | `experimental` |
| React UI | `tree-view`, `message-renderer`, `modal-mount`, `context-panel`, `configComponent` | `unsupported` |
| Data / assets | `fonts`, `wallpapers`, `density-preset`, `scheduler`, and every declarative capability | n/a (`execution: host`) |

## Impedance mismatches and how each is handled

These are the reasons the second tier is experimental. None is stubbed.

**Synchronous methods.** `ProtocolAdapter.isConnected()`,
`PlatformAdapter.health()` and `PlatformAdapter.a2uiCapability()` are
synchronous; an IPC round-trip cannot answer them. The wrappers track that state
host-side around `connect`/`disconnect` and `start`/`stop`/`send`, and cache the
A2UI matrix from the one-time `describe()`.

**Non-serializable context.** `AdapterContext` carries live functions (`emit`,
`logger`, `secrets`, `signal`). Only the serializable identity travels to
Python; the inbound `emit` path comes *back* over the push channel and the
wrapper forwards it into the connector bus.

**Continuations.** `ChatMiddleware` receives `next`, a JS closure running the
rest of the chain. Passing it across the boundary would require the host to make
a nested `plugin_python_call` while the first is suspended — re-entrant
machinery that belongs to the SDK, not a bridge. Instead a python middleware
implements `before`/`after` and the wrapper synthesizes around-semantics
(mutate request, mutate response, short-circuit). **Limitation:** it cannot
invoke the continuation more than once, so retry/fan-out control flow stays
JS-only.

**Latency.** Inline terminal completion is latency-budgeted and pays an extra
IPC round-trip per request.

## Enforcement

Graduated, and identical in the Rust linter and the runtime validator:

- a `type: "python"` plugin declaring an `unsupported` capability → **error**
  (`manifest.contributions.javascript.unsupported_for_python`);
- a python-backed `experimental` capability → **warning**
  (`manifest.contributions.python.experimental`);
- `entry`/`export` are required only when the entry resolves to the JS backend.

Execution of the experimental tier is additionally gated by
`lib/plugin/python/experimental-flag.ts`, which reads the tier from the contract
rather than a hand-kept list — flipping a capability to `supported` retires the
gate automatically. **Default off**: registration always happens (so the
manifest, linter and plugin detail UI stay honest); only the executing bridges
consult the flag.

## Consequences

- A pure-Python plugin can own the nine `supported` capabilities with no
  JavaScript at all.
- `hybrid` plugins should set `backend` explicitly: an omitted backend resolves
  to `"js"`, rarely what a hybrid author means for a Python handler.
- The reserved dispatcher `__cognia_dispatch_contribution__` is exempt from the
  private-name guard in **both** `host.py` and `commands.rs`; plugin symbols
  beginning with `_` are still rejected.
- `get_info()` / `import_main` now report `contribution_count`, so a plugin that
  registers nothing is visible instead of silently inert.
- Verified end-to-end against a real interpreter:
  `first_party_python_runtime_demo_contributions_dispatch` loads
  `plugins/cognia-python-runtime-demo` and dispatches its OCR, workspace and
  connector contributions.

## Alternatives considered

**A separate `pythonRuntime` table on `PLUGIN_CAPABILITY_CONTRACTS`** — the
approach originally planned. Rejected once the audit found `execution` already
modelled the same dimension: a second table would have drifted from the first
and would not have reached the Rust or Python mirrors.

**Per-bridge bespoke integrations** — rejected for the nine clean capabilities
(the proxy is uniform), accepted only where the contract genuinely differs
(connector, external-agent adapter, chat middleware).

**A real continuation protocol for chat middleware** — deferred. It needs
re-entrant call handling in `host.py` and a resume RPC; the `before`/`after`
split covers the realistic cases without pretending.
