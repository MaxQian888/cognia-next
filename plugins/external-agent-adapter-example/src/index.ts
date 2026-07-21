/**
 * External Agent Adapter Example — reference plugin for the
 * `external-agent-adapter` capability.
 *
 * Demonstrates a COMPLETE, dynamically-loadable external agent contributed by a
 * single plugin, exercising both halves of the seam end-to-end:
 *
 *  - `external-agent-adapter`: a declarative `externalAgentAdapters[]` entry
 *    whose lazy `entry`/`export` factory the external-agent-adapters module
 *    bridge imports on enable and registers into the external-agent
 *    `protocolAdapterRegistry` under the namespaced protocol
 *    `${pluginId}:demo-echo` (see `src/demo-adapter.ts`).
 *  - `external-agent-preset`: a matching `externalAgentPresets[]` entry whose
 *    `protocol` references that namespaced adapter, so the contributed agent
 *    appears in the quick-start gallery and can be connected like a built-in.
 *
 * Registration is fully declarative — the plugin manager's capability dispatch
 * loops read the manifest arrays, so no imperative activate() wiring is needed.
 */

import type { ExternalAgentProtocol } from "@/types/agent/external-agent"
import type {
  PluginDefinition,
  PluginExternalAgentAdapterDef,
  PluginExternalAgentPresetDef,
  PluginManifest,
} from "@/types/plugin"

import manifestJson from "../plugin.json"

const PLUGIN_ID = "cognia-external-agent-adapter-example"
const ADAPTER_ID = "demo-echo"

/** The protocol the host registers this plugin's adapter under. */
const NAMESPACED_PROTOCOL = `${PLUGIN_ID}:${ADAPTER_ID}`

const demoAdapter: PluginExternalAgentAdapterDef = {
  id: ADAPTER_ID,
  label: "Demo Echo Protocol",
  description: "A reference external-agent protocol adapter (echo, no subprocess).",
  entry: "src/demo-adapter.ts",
  export: "createDemoEchoAdapter",
}

/**
 * Preset that drives the contributed adapter. `protocol` references the
 * namespaced adapter id — a plugin's own protocol falls outside the closed
 * `ExternalAgentProtocol` union, so the cast is expected for plugin presets.
 */
const demoPreset: PluginExternalAgentPresetDef = {
  id: "demo-echo-agent",
  name: "Demo Echo Agent",
  description: "A complete external agent contributed end-to-end by one plugin.",
  protocol: NAMESPACED_PROTOCOL as ExternalAgentProtocol,
  // The echo adapter spawns no subprocess, so a non-stdio transport keeps it
  // runnable in any runtime (stdio would pull in the desktop-only gate). With
  // supportTier "executable" the agent actually passes getExternalAgentExecutionBlock
  // while the plugin is enabled — the ADR-0051 "executable while enabled" property.
  transport: "sse",
  defaultPermissionMode: "default",
  supportTier: "executable",
  tags: ["example", "reference"],
}

/**
 * The manifest is plugin.json verbatim — the contributions live THERE, not
 * here. An installed copy only ever reads plugin.json (the TS module-manifest
 * overlay is a `builtinManifest()` merge that applies to bundled builtins, and
 * this plugin is deliberately unbundled), so declaring the arrays only in TS
 * meant this reference plugin registered nothing in any runtime.
 *
 * `demoAdapter` / `demoPreset` below are kept as TYPED mirrors of the JSON so
 * a change to either shape still fails the build.
 */
export const manifest = manifestJson as unknown as PluginManifest

/**
 * Typed mirrors of the two plugin.json entries. Exported so the co-located
 * test can assert they deep-equal the JSON: that keeps the JSON (which is what
 * actually ships) honest against the SDK types without reintroducing a second
 * runtime source of truth.
 */
export const TYPED_CONTRIBUTIONS = {
  adapter: demoAdapter,
  preset: demoPreset,
} as const

const definition: PluginDefinition = {
  manifest,
  // Declarative registration (manifest arrays are dispatched by the manager).
  activate: async () => {},
}

export default definition
