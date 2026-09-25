/**
 * Playwright MCP plugin — contributes two Microsoft Playwright MCP server
 * presets to cognia-next's MCP gallery and a `/browser` setup guide that
 * walks through every Playwright option (plugin- and static-catalog-owned
 * alike).
 *
 * The gallery's static `MCP_PRESETS` table already ships `playwright` and
 * `playwright-existing-browser`, and static ids always win the merged
 * catalog (`lib/mcp/preset-catalog.ts` skips dynamic entries that collide).
 * Re-registering those ids here would produce dead entries, so this plugin
 * only adds the modes the static table lacks:
 *
 *  - `playwright-isolated` — `--isolated --headless`: disposable in-memory
 *    profile, no window. The unattended/privacy-preserving variant.
 *  - `playwright-cdp` — `--cdp-endpoint <CDP_ENDPOINT>`: attach to a Chrome
 *    or Edge the user launched with `--remote-debugging-port`.
 *
 * Both presets are declared in plugin.json (`mcpServerPresets`), so the
 * manager registers them on enable; nothing is registered imperatively.
 *
 * The `/browser` command opens the setup modal (`ctx.modal.openModal`) which
 * compares all four modes and deep-links into Settings → MCP Servers via
 * the panel's `?preset=` param (`ctx.ui.navigate`).
 *
 * Part of M3 of the plugin-first Computer Use plan.
 */

import { definePlugin, definePluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { handleBrowserCommand } from "./commands"
import { setSetupModalHost } from "./runtime"

// plugin.json is the whole manifest: the two presets (`mcpServerPresets`) and
// the i18n bundle are declarative, so the manager registers the presets on
// enable (`OVERLAY_REGISTRY_CAPABILITIES["mcp-server-preset"]`) and drops them
// on disable — for the built-in and for an installed copy alike.
export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  activate: async (ctx) => {
    ctx.logger.info("playwright-mcp plugin activated")

    // The setup modal's environment check and "Set up in Settings" reach the
    // host through this slot — modal components only receive
    // PluginModalProps. Cleared via the generation lifecycle so a
    // re-activation can't leak a stale API.
    setSetupModalHost({ shell: ctx.shell, navigate: (href) => ctx.ui.navigate(href) })
    ctx.lifecycle.onDispose(() => setSetupModalHost(undefined), "playwright-mcp:modal-host")

    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here — the supported shape per the author-SDK migration table. The
    // manager owns registration (namespaced id, conflict detection, aliases,
    // command-palette entry, idle-clock refresh) and teardown.
    return {
      onCommand: async (command: string, args: string[]) =>
        handleBrowserCommand(ctx, command, args) ?? false,
    }
  },
})
