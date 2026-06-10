/**
 * Stagehand MCP plugin — contributes a Browserbase Stagehand preset to
 * cognia-next's MCP gallery.
 *
 * Stagehand is the AI-native layer over Playwright (act/extract/observe/
 * agent primitives). Compared to raw Playwright it's higher-level and
 * better for vague natural-language tasks, but it requires (a) a
 * Browserbase account for cloud Chromium and (b) an OpenAI key for the
 * vision step. Both are surfaced as secret-typed manifest fields so the
 * settings UI prompts for them on first attach.
 *
 * Part of M3 of the plugin-first Computer Use plan.
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { defineMcpServerPreset } from "@/lib/plugin/sdk"
import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/slash-commands/registry"

const STAGEHAND_PRESET = defineMcpServerPreset({
  id: "stagehand",
  name: "Stagehand",
  description:
    "AI-native browser automation (act / extract / observe / agent). Cloud Chromium via Browserbase; vision powered by OpenAI.",
  icon: "🎭",
  transport: "stdio",
  config: {
    command: "npx",
    args: ["-y", "@browserbasehq/mcp-stagehand"],
    env: { BROWSERBASE_API_KEY: "", BROWSERBASE_PROJECT_ID: "", OPENAI_API_KEY: "" },
  },
  fields: [
    {
      key: "BROWSERBASE_API_KEY",
      label: "Browserbase API key",
      placement: "env",
      secret: true,
      description: "Get one at browserbase.com.",
    },
    {
      key: "BROWSERBASE_PROJECT_ID",
      label: "Browserbase project ID",
      placement: "env",
    },
    {
      key: "OPENAI_API_KEY",
      label: "OpenAI API key (Stagehand vision)",
      placement: "env",
      secret: true,
      description: "Stagehand uses GPT-4o for its observe step.",
    },
  ],
  runtime: "both",
  docsUrl: "https://github.com/browserbase/mcp-server-browserbase",
  tags: ["web", "browser", "ai-native"],
})

const definition: PluginDefinition = {
  manifest: {
    id: "cognia-stagehand-mcp",
    name: "Stagehand Browser",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["mcp-server-preset", "commands"],
    main: "src/index.ts",
    mcpServerPresets: [STAGEHAND_PRESET],
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("stagehand-mcp plugin activated")

    ctx.agent?.registerMcpServerPreset?.(STAGEHAND_PRESET)

    registerSlashCommand({
      id: "stagehand.attach",
      name: "/stagehand",
      description: "Attach the Stagehand MCP browser to the current character.",
      handler: () => ({
        message:
          "Open Settings → MCP Servers, click Stagehand in the gallery, fill in the Browserbase + OpenAI keys, then attach it to the current character.",
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
