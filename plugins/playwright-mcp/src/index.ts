/**
 * Playwright MCP plugin — contributes a Microsoft Playwright MCP server
 * preset to cognia-next's MCP gallery.
 *
 * Once enabled, isolated-browser and existing-browser presets appear in
 * Settings → MCP Servers → Add server gallery. The user picks one, and the
 * existing `applyPresetFields`
 * helper materialises a per-user `McpServer` row (no env vars required
 * for the headless default), and any character that attaches to it via
 * `character.mcpServerIds` gets the 40+ browser tools through both the
 * SDK sidecar and the ai-sdk runtime (M2 bridge — once landed).
 *
 * Part of M3 of the plugin-first Computer Use plan.
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { defineMcpServerPreset } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

const PLAYWRIGHT_PRESET = defineMcpServerPreset({
  id: "playwright",
  name: "Playwright",
  description:
    "Browser automation: navigate, click, type, screenshot, accessibility-tree extraction. Headless Chromium by default.",
  icon: "🎬",
  transport: "stdio",
  config: {
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
  },
  fields: [],
  runtime: "both",
  docsUrl: "https://github.com/microsoft/playwright-mcp",
  tags: ["web", "browser", "automation"],
})

const PLAYWRIGHT_EXISTING_BROWSER_PRESET = defineMcpServerPreset({
  id: "playwright-existing-browser",
  name: "Playwright — Existing Browser",
  description:
    "Control selected Chrome or Edge tabs through the official Playwright extension, reusing the browser's current profile and login state.",
  icon: "🌐",
  transport: "stdio",
  config: {
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--extension"],
  },
  fields: [],
  defaultDisallowedTools: ["browser_run_code_unsafe"],
  runtime: "both",
  docsUrl: "https://github.com/microsoft/playwright/tree/main/packages/extension",
  tags: ["web", "browser", "automation", "existing-profile"],
})

const PLAYWRIGHT_PRESETS = [PLAYWRIGHT_PRESET, PLAYWRIGHT_EXISTING_BROWSER_PRESET]

const definition: PluginDefinition = {
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here would WIN and silently drop `commands[]`.
  manifest: {
    ...(manifestJson as object),
    mcpServerPresets: PLAYWRIGHT_PRESETS,
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("playwright-mcp plugin activated")

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
      onCommand: async (command: string) => {
        if (command !== "browser") return false
        ctx.ui?.showToast?.(
          "Open Settings → MCP Servers, choose Playwright or Playwright — Existing Browser, then attach it to the current character. Existing Browser also requires the official Playwright extension and per-connection tab approval.",
          "info"
        )
        return true
      },
    }
  },
}

export default definition
