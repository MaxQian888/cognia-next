---
title: ADR-0051 — External-agent adapters as a dynamically-loadable plugin type
description: "Close the loop that made external agents only half a plugin type: presets were already plugin-contributable, but the protocol adapters that give a new agent its targeted behaviour (handshake, session lifecycle, streaming, health) were hardcoded. Add an external-agent-adapter capability so a plugin can contribute a brand-new external-agent protocol into the same protocolAdapterRegistry the built-ins use, register/unregister on enable/disable, and ship a complete dynamically-loadable agent (adapter + matching preset)."
---

# ADR-0051 — External-agent adapters as a dynamically-loadable plugin type

**Status**: Accepted (2026-06-20)
**Authors**: Max Qian + Claude Opus 4.8
**Builds on**: ADR-0049 (external-agent process management hardening), ADR-0032 (agent-team plugin integration; the overlay/module-bridge contribution patterns), the external-agent subsystem (`lib/ai/agent/external/`), and the plugin module-bridge dispatch (`lib/plugin/contracts/module-bridge-map.ts`).

## Context

The external-agent subsystem splits cleanly into a **unified** layer and a
**targeted** layer:

- **Unified** — the generic Rust process layer (`command_resolver` → spawn →
  `kill_on_drop` → event sink, hardened in ADR-0049) and the preset → config →
  `addAgent` pipeline. One code path for every agent; no per-vendor branching.
- **Targeted** — the four protocol adapters (`acp`, `codex-app-server`,
  `opencode`, `a2a`) that own each protocol's handshake, session lifecycle,
  streaming semantics, health probe, and session extensions.

Plugins could already contribute the unified half: the `external-agent-preset`
capability registers a configuration into a runtime overlay, and the preset can
piggy-back on a built-in protocol. But the **targeted** half was closed —
`ExternalAgentManager.registerDefaultAdapters()` hardcoded the four adapters into
the `protocolAdapterRegistry`, and that registry was never exposed to the plugin
runtime. A preset whose `protocol` was not one of the four threw
`Unsupported protocol` at `addAgent`. (The same-named `protocolAdapters` plugin
capability is unrelated — it targets the **LLM-provider** registry
`lib/ai/providers/protocol-adapter-registry.ts`, not external agents.)

So "external agents are a dynamically-loadable plugin type" was only half true:
a plugin could describe *where to find* an agent it already understood, but could
not teach the host a *new* agent's protocol.

## Decision

Add a first-class **`external-agent-adapter`** plugin capability — the
targeted-behaviour twin of `external-agent-preset` — wired through the existing
module-bridge machinery, so a plugin can ship a complete, dynamically-loadable
external agent (adapter + matching preset) with zero new Rust.

### 1 · Plugin-tracked overlay on the existing registry

`lib/ai/agent/external/protocol-adapter.ts` gains a plugin overlay
(`registerPluginProtocolAdapter` / `unregisterPluginProtocolAdaptersByPlugin` +
owner map). Contributed adapters register into the **same**
`protocolAdapterRegistry` the four built-ins use — so `addAgent`'s
`protocolAdapterRegistry.create(protocol)` is origin-agnostic and the manager
never branches on whether a protocol is host- or plugin-provided. Registration is
namespaced `${pluginId}:${id}`; the overlay refuses to overwrite a built-in or
another plugin's protocol, and a plugin's disable removes exactly its adapters.

### 2 · A code-only module bridge

`lib/plugin/bridge/external-agent-adapters-bridge.ts` (mirroring the LLM
protocol-adapters bridge) lazy-imports each `externalAgentAdapters[].entry`
export — a `() => ProtocolAdapter` factory — in the renderer (where plugin code
legitimately runs) and registers it into the overlay. It is wired into the
field-driven `MODULE_BRIDGE_CAPABILITIES` map, so the manager's enable/disable
dispatch picks it up automatically. An imperative twin,
`ctx.agent.registerExternalAgentAdapter(id, factory)`, covers activate-time
registration.

### 3 · Registry-aware execution gating (full-chain correctness)

`getExternalAgentExecutionBlock` previously blocked any protocol outside the
static supported set. It now also accepts a protocol currently registered in the
`protocolAdapterRegistry`, so a contributed agent is executable **while its
providing plugin is enabled** — and correctly reverts to a blocked,
clearly-explained state ("enable the plugin that contributes it") once the plugin
is disabled and its adapter unregistered. `addAgent`'s unknown-protocol error was
likewise made plugin-aware.

### 4 · First-class contract + reference

A `PLUGIN_CAPABILITY_CONTRACTS` entry (`support: "supported"`) carries the host
bindings, TS + Python SDK helpers (`defineExternalAgentAdapter` /
`define_external_agent_adapter`), and the reference plugin
`plugins/external-agent-adapter-example/` (a self-contained echo adapter plus a
matching preset, exercised end-to-end). The Rust offline linter's capability
lists (`crates/cognia-cli/src/cmd_lint.rs`) are kept in set-equality with the
canonical list (guarded by `rust-capability-parity.test.ts`).

## Consequences

- A plugin can now integrate a genuinely new external agent end-to-end without a
  host code change — the last gap that made external agents only half a plugin
  type is closed.
- Spawning stays in the hardened generic Rust layer (ADR-0049); a contributed
  adapter owns only renderer-side protocol/session logic. Process-spawning is
  never delegated to plugin JS.
- The targeted layer is now uniformly contributable by host and plugin through
  one registry contract, while the unified layer (process + preset) is unchanged
  — the "unified vs targeted" split is preserved, not blurred.
- A stored agent config that references a plugin protocol degrades gracefully
  (clear, actionable block reason) when its plugin is disabled, rather than
  failing opaquely.
