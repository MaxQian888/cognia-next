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
import type { PluginContext, PluginDefinition, PluginManifest } from "@/types/plugin"
import { registerResearchSkill } from "./skill"
import { handleResearchSlash } from "./slash"
import { registerDeepResearchTool } from "./tool"
import manifestJson from "../plugin.json"

const definition: PluginDefinition = {
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here WINS and would silently drop `commands[]`.
  manifest: manifestJson as unknown as PluginManifest,
  activate: (ctx: PluginContext) => {
    ctx.logger?.info?.("deep-research activated")
    registerDeepResearchTool(ctx)
    registerResearchSkill(ctx)
    // `/research` is DECLARED in plugin.json (`commands[]`). It used to ALSO be
    // registered imperatively, so the registry held two entries: the manifest
    // one (which, lacking an `onCommand` hook, always answered "Plugin command
    // not handled") and the working imperative one. Returning the hook makes
    // the declared entry the real one, and the duplicate disappears.
    return {
      onCommand: async (command: string, args: string[]) => {
        if (command !== "research") return false
        const result = await handleResearchSlash(ctx, args.join(" "))
        if (result?.message) ctx.ui?.showToast?.(result.message, "info")
        return true
      },
    }
  },
}

export default definition
