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
 * The `/browser` command opens the setup modal (`ctx.modal.openModal`) which
 * compares all four modes and deep-links into Settings → MCP Servers via
 * the panel's `?preset=` param.
 *
 * Part of M3 of the plugin-first Computer Use plan.
 */

import type { PluginContext, PluginDefinition } from "@cognia/plugin-sdk"
import { defineMcpServerPreset, definePluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { I18N_MESSAGES } from "./i18n"
import { handleBrowserCommand } from "./commands"
import { setPluginShell } from "./runtime"

const PLAYWRIGHT_ISOLATED_PRESET = defineMcpServerPreset({
  id: "playwright-isolated",
  name: "Playwright — Isolated",
  description:
    "Disposable in-memory browser profile — nothing persists between runs — driven headless so no window opens.",
  icon: "🎬",
  transport: "stdio",
  config: {
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--isolated", "--headless"],
  },
  fields: [],
  runtime: "both",
  docsUrl: "https://github.com/microsoft/playwright-mcp",
  tags: ["web", "browser", "automation"],
})

const PLAYWRIGHT_CDP_PRESET = defineMcpServerPreset({
  id: "playwright-cdp",
  name: "Playwright — Attach over CDP",
  description:
    "Attach to a Chrome or Edge you launched yourself with --remote-debugging-port — for dev loops and inspecting a live session.",
  icon: "🖥️",
  transport: "stdio",
  config: {
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--cdp-endpoint", "<CDP_ENDPOINT>"],
  },
  fields: [
    {
      key: "CDP_ENDPOINT",
      label: "CDP endpoint",
      placement: "arg-replace",
      token: "<CDP_ENDPOINT>",
      placeholder: "http://localhost:9222",
      description:
        "Start the browser first, e.g. chrome --remote-debugging-port=9222, then paste its CDP URL.",
    },
  ],
  runtime: "both",
  docsUrl: "https://github.com/microsoft/playwright-mcp",
  tags: ["web", "browser", "automation", "cdp"],
})

const PLAYWRIGHT_PRESETS = [PLAYWRIGHT_ISOLATED_PRESET, PLAYWRIGHT_CDP_PRESET]

const definition: PluginDefinition = {
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here would WIN and silently drop `commands[]`.
  manifest: definePluginManifest({
    ...manifestJson,
    mcpServerPresets: PLAYWRIGHT_PRESETS,
    i18n: { locales: I18N_MESSAGES },
  }),
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("playwright-mcp plugin activated")

    // The setup modal's environment check reaches `ctx.shell` through this
    // slot — modal components only receive PluginModalProps. Cleared via
    // the generation lifecycle so a re-activation can't leak a stale API.
    setPluginShell(ctx.shell)
    ctx.lifecycle?.onDispose(() => setPluginShell(undefined), "playwright-mcp:shell")

    // The manifest-driven registration already happens in
    // PluginManager.registerPluginContributions (M1·T5). The imperative
    // call here is a no-op idempotency belt-and-suspenders for users who
    // load the plugin via the dynamic ctx.agent path rather than through
    // the manifest reader.
    for (const preset of PLAYWRIGHT_PRESETS) {
      ctx.agent?.registerMcpServerPreset?.(preset)
    }

    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here — the supported shape per the author-SDK migration table. The
    // manager owns registration (namespaced id, conflict detection, aliases,
    // command-palette entry, idle-clock refresh) and teardown.
    return {
      onCommand: async (command: string, args: string[]) =>
        handleBrowserCommand(ctx, command, args) ?? false,
    }
  },
}

export default definition
