/**
 * Deep Research — built-in plugin.
 *
 * A fully self-contained DeepSearch/DeepResearch agent: an autonomous
 * search → read → reason → cited-answer loop that runs entirely in-plugin using
 * the host model bridge (`ctx.ai`) + its own search provider (own API key via
 * `fetch`). The engine imports nothing from the host app; the only host
 * touch-points are the SDK registries (tool / slash / skill) and `@/types`.
 *
 * Two entry points:
 *   - `deep_research` agent tool — model-invoked, streams step progress.
 *   - `/research <question>` slash — user-invoked, returns a final cited card.
 */
import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { unregisterCommandsByPlugin } from "@/lib/slash-commands/registry"
import { PLUGIN_ID } from "./config"
import { registerResearchSkill } from "./skill"
import { registerResearchSlash } from "./slash"
import { registerDeepResearchTool } from "./tool"

const definition: PluginDefinition = {
  manifest: {
    id: PLUGIN_ID,
    name: "Deep Research",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["tools", "commands", "skills"],
    main: "src/index.ts",
  } as never,
  activate: (ctx: PluginContext) => {
    ctx.logger?.info?.("deep-research activated")
    registerDeepResearchTool(ctx)
    registerResearchSlash(ctx)
    registerResearchSkill(ctx)
  },
  deactivate: () => {
    // Tools + skills are auto-unregistered by the runtime; slash commands are
    // keyed by plugin id and removed explicitly.
    unregisterCommandsByPlugin(PLUGIN_ID)
  },
}

export default definition
