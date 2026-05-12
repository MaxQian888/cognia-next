/**
 * Playwright MCP plugin — contributes a Microsoft Playwright MCP server
 * preset to cognia-next's MCP gallery.
 *
 * Once enabled, "Playwright" appears in Settings → MCP Servers → Add
 * server gallery. The user picks it, the existing `applyPresetFields`
 * helper materialises a per-user `McpServer` row (no env vars required
 * for the headless default), and any character that attaches to it via
 * `character.mcpServerIds` gets the 40+ browser tools through both the
 * SDK sidecar and the ai-sdk runtime (M2 bridge — once landed).
 *
 * Part of M3 of the plugin-first Computer Use plan.
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { defineMcpServerPreset } from "@/lib/plugin/sdk"
import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/chat/slash-command-registry"

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

const definition: PluginDefinition = {
  manifest: {
    id: "cognia-playwright-mcp",
    name: "Playwright Browser",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["mcp-server-preset", "commands"],
    main: "src/index.ts",
    mcpServerPresets: [PLAYWRIGHT_PRESET],
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("playwright-mcp plugin activated")

    // The manifest-driven registration already happens in
    // PluginManager.registerPluginContributions (M1·T5). The imperative
    // call here is a no-op idempotency belt-and-suspenders for users who
    // load the plugin via the dynamic ctx.agent path rather than through
    // the manifest reader.
    ctx.agent?.registerMcpServerPreset?.(PLAYWRIGHT_PRESET)

    registerSlashCommand({
      id: "playwright.attach",
      name: "/browser",
      description: "Attach the Playwright MCP browser to the current character.",
      handler: () => ({
        message:
          "Open Settings → MCP Servers, click Playwright in the gallery, then attach it to the current character via the chip list.",
      }),
      source: "plugin",
      pluginId: ctx.pluginId,
    })
  },
  deactivate: async (ctx?: PluginContext) => {
    if (ctx?.pluginId) {
      unregisterCommandsByPlugin(ctx.pluginId)
    }
  },
}

export default definition
