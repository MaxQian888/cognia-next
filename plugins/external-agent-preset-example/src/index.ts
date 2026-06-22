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

import type { PluginDefinition, PluginManifest, PluginExternalAgentPresetDef } from "@/types/plugin"

const PLUGIN_ID = "cognia-external-agent-preset-example"

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

export const manifest: PluginManifest = {
  id: PLUGIN_ID,
  name: "External Agent Preset Example",
  version: "0.1.0",
  type: "frontend",
  capabilities: ["external-agent-preset", "context-provider"],
  main: "src/index.ts",
  externalAgentPresets: [examplePreset],
  contextProviders: [
    {
      id: "env-banner",
      label: "Environment Banner",
      entry: "src/context-provider.ts",
      export: "createEnvBannerProvider",
    },
  ],
} as PluginManifest

const definition: PluginDefinition = {
  manifest,
  // Declarative registration (manifest arrays are dispatched by the manager).
  activate: async () => {},
}

export default definition
