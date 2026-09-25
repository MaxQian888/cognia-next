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
 *   - `/research <question>` slash — user-invoked, answers into the chat in
 *     the user's language (strings live in plugin.json `i18n.locales`).
 *
 * The playbook skill (`cognia-deep-research:deep-research`) rides the
 * manifest, so it is reachable from the composer's skill picker.
 */
import { definePlugin, definePluginManifest, type PluginContext } from "@cognia/plugin-sdk"

import { DEEP_RESEARCH_SKILL } from "./skill"
import { handleResearchSlash } from "./slash"
import { registerDeepResearchTool } from "./tool"
import manifestJson from "../plugin.json"

// Spread plugin.json (commands, tools, i18n bundle, config schema) and add the
// playbook skill, which the manager registers on enable — the plugin no longer
// registers it imperatively as well.
export const manifest = definePluginManifest({
  ...manifestJson,
  skills: [DEEP_RESEARCH_SKILL],
})

export default definePlugin({
  manifest,
  activate: (ctx: PluginContext) => {
    registerDeepResearchTool(ctx)
    // `/research` is DECLARED in plugin.json (`commands[]`); returning the
    // hook makes the declared entry the real one.
    return {
      onCommand: async (command, args, context) => {
        if (command !== "research") return false
        // Returning the report as the command's own `message` puts it in the
        // conversation — a multi-page cited report in a toast is unreadable.
        return handleResearchSlash(ctx, args.join(" "), context)
      },
    }
  },
})
