/**
 * Ripgrep Tools — built-in plugin.
 *
 * Intentionally (almost) empty: the whole point of this plugin is that
 * `manifest.cliTools` declaratively wraps ripgrep as an agent tool with
 * ZERO imperative code. The manager materializes `ripgrep_search` from
 * the manifest at enable time and routes execution through the
 * `lib/plugin/cli-tools` safety pipeline (cli:execute consent, binary
 * detection, injection-proof argv templating, audit).
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"

const definition: PluginDefinition = {
  manifest: {
    id: "ripgrep-tools",
    name: "Ripgrep Tools",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["cli-tools"],
    main: "src/index.ts",
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("ripgrep-tools activated (cliTools are manifest-driven)")
  },
}

export default definition
