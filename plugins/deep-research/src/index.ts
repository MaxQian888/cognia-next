/**
 * Deep Research — built-in plugin.
 *
 * A DeepSearch/DeepResearch agent: an autonomous
 * search → read → reason → cited-answer loop that runs entirely in-plugin over
 * the PUBLIC plugin SDK — the model through `ctx.ai`, search and page reads
 * through the host's promoted `web_search` / `web_fetch` tools. Nothing here
 * imports host internals, and the host has no branch that knows this plugin by
 * name. The engine itself stays pure and dependency-injected; only the runtime
 * adapter touches `ctx`.
 *
 * Two entry points:
 *   - `deep_research` agent tool — model-invoked, streams step progress.
 *   - `/research <question>` slash — user-invoked, answers into the chat.
 */
import {
  definePlugin,
  type PluginContext,
  type PluginDefinition,
  type PluginManifest,
} from "@cognia/plugin-sdk"

import { registerResearchSkill } from "./skill"
import { handleResearchSlash } from "./slash"
import { registerDeepResearchTool } from "./tool"
import manifestJson from "../plugin.json"

const definition: PluginDefinition = definePlugin({
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here WINS and would silently drop `commands[]`.
  manifest: manifestJson as unknown as PluginManifest,
  activate: (ctx: PluginContext) => {
    ctx.logger.info("deep-research activated")
    registerDeepResearchTool(ctx)
    registerResearchSkill(ctx)
    // `/research` is DECLARED in plugin.json (`commands[]`). It used to ALSO be
    // registered imperatively, so the registry held two entries: the manifest
    // one (which, lacking an `onCommand` hook, always answered "Plugin command
    // not handled") and the working imperative one. Returning the hook makes
    // the declared entry the real one, and the duplicate disappears.
    return {
      onCommand: async (command, args, context) => {
        if (command !== "research") return false
        // Returning the report as the command's own `message` puts it in the
        // conversation. It used to be shown as a toast — a multi-page cited
        // report in a transient popup, unreadable and unscrollable.
        return handleResearchSlash(ctx, args.join(" "), context)
      },
    }
  },
})

export default definition
