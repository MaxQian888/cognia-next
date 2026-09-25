/**
 * Stagehand MCP plugin — contributes two Browserbase Stagehand presets to
 * cognia-next's MCP gallery and a `/stagehand` setup guide that compares
 * them:
 *
 *  - `stagehand-hosted` — Browserbase's hosted Streamable-HTTP endpoint
 *    (`https://mcp.browserbase.com/mcp`). The path upstream recommends: no
 *    local Node.js, and the default Gemini model cost is covered — the only
 *    credential is the API key, sent as an `x-bb-api-key` header so the
 *    host's credential vault can externalize it (upstream's
 *    `?browserbaseApiKey=` query-param auth is a deprecated fallback; the
 *    header keeps the key out of the URL entirely).
 *  - `stagehand` — self-hosted stdio spawn of `@browserbasehq/mcp` via npx.
 *    Full CLI flag control (--modelName, --proxies, --keepAlive, …) at the
 *    cost of a Node.js toolchain and three credentials (Browserbase API key,
 *    project ID, and a model key — Gemini by default).
 *
 * Both presets live only in plugin.json (pure data — visible to static
 * tooling before activation, and the packaged manifest is the install-time
 * source of truth); the manager registers them on enable.
 *
 * Model-key guidance: the hosted URL field mentions `?modelApiKey=` and the
 * self-hosted key field mentions `--modelApiKey`. Both are vaulted by the
 * host (`lib/mcp/credentials.ts` matches any name ending in `api[_-]?key`, and
 * its test pins exactly these two spellings), so neither persists in plain
 * text.
 *
 * The `/stagehand` command opens the setup modal (`ctx.modal.openModal`)
 * which deep-links into Settings → MCP Servers via the panel's `?preset=`
 * param (`ctx.ui.navigate`).
 *
 * Part of M3 of the plugin-first Computer Use plan.
 */

import { definePlugin, definePluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { handleStagehandCommand } from "./commands"
import { setSetupModalHost } from "./runtime"

// plugin.json is the whole manifest — presets, command and i18n bundle — so
// the manager registers the presets on enable for the built-in and for an
// installed copy alike.
export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  activate: async (ctx) => {
    ctx.logger.info("stagehand-mcp plugin activated")

    // The setup modal's environment check and "Set up in Settings" reach the
    // host through this slot — modal components only receive
    // PluginModalProps. Cleared via the generation lifecycle so a
    // re-activation can't leak a stale API.
    setSetupModalHost({ shell: ctx.shell, navigate: (href) => ctx.ui.navigate(href) })
    ctx.lifecycle.onDispose(() => setSetupModalHost(undefined), "stagehand-mcp:modal-host")

    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here — the supported shape per the author-SDK migration table. The
    // manager owns registration (namespaced id, conflict detection, aliases,
    // command-palette entry, idle-clock refresh) and teardown.
    return {
      onCommand: async (command: string, args: string[]) =>
        handleStagehandCommand(ctx, command, args) ?? false,
    }
  },
})
