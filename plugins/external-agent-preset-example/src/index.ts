/**
 * External Agent Preset Example — reference plugin (Threads C1 + C2).
 *
 * Demonstrates two contribution seams end-to-end:
 *  - `external-agent-preset`: a declarative `externalAgentPresets[]` entry the
 *    plugin manager registers into the preset overlay (`registerPreset`), so it
 *    appears in the external-agent quick-start gallery alongside the four
 *    builtins and can back a team teammate / dispatched subagent (Thread A).
 *  - `contextProviders`: a declarative lazy-factory entry the context-providers
 *    module-bridge registers into the context-provider registry, exercising the
 *    new manifest field shipped in Thread C1.
 *
 * Registration is fully declarative — the plugin manager's capability dispatch
 * loops read the manifest arrays, so no imperative activate() wiring is needed.
 */

import type {
  PluginDefinition,
  PluginManifest,
  PluginExternalAgentPresetDef,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

/** Re-exported from the JSON so callers/tests share one source of truth. */
export const PLUGIN_ID = manifestJson.id

/**
 * A generic ACP-over-stdio preset. Uses a unique id so it can never shadow a
 * builtin preset (codex / claude-code / gemini-cli / cursor-cli).
 */
const examplePreset: PluginExternalAgentPresetDef = {
  id: "example-acp-cli",
  name: "Example ACP CLI",
  description: "A reference external agent preset wired over ACP stdio.",
  protocol: "acp",
  transport: "stdio",
  process: {
    command: "npx",
    args: ["-y", "example-acp-agent", "--stdio"],
  },
  envVarHint: "EXAMPLE_ACP_API_KEY",
  defaultPermissionMode: "default",
  supportTier: "documented-only",
  tags: ["example", "reference"],
}

/**
 * The manifest is plugin.json verbatim — the contributions live THERE, not
 * here. An installed copy only ever reads plugin.json (the TS module-manifest
 * overlay is a `builtinManifest()` merge that applies to bundled builtins, and
 * this plugin is deliberately unbundled), so declaring the arrays only in TS
 * meant this reference plugin registered nothing in any runtime.
 */
export const manifest = manifestJson as unknown as PluginManifest

/**
 * Typed mirror of the plugin.json preset entry. Exported so the co-located
 * test can assert it deep-equals the JSON — that keeps the JSON (which is what
 * actually ships) honest against the SDK types without reintroducing a second
 * runtime source of truth.
 */
export const TYPED_CONTRIBUTIONS = { preset: examplePreset } as const

const definition: PluginDefinition = {
  manifest,
  // Declarative registration (manifest arrays are dispatched by the manager).
  activate: async () => {},
}

export default definition
