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
import { defineMcpServerPreset } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

const STAGEHAND_PRESET = defineMcpServerPreset({
  id: "stagehand",
  name: "Stagehand",
  description:
    "AI-native browser automation (act / extract / observe / agent). Cloud Chromium via Browserbase; vision powered by OpenAI.",
  icon: "🎭",
  transport: "stdio",
  config: {
    // Upstream moved twice: `@browserbasehq/mcp-stagehand` (what this preset
    // used to point at) is a hard npm 404, and its successor
    // `@browserbasehq/mcp-server-browserbase` is deprecated in favour of
    // `@browserbasehq/mcp`. The old name made `npx` fail at spawn every time.
    command: "npx",
    args: ["-y", "@browserbasehq/mcp@latest"],
    env: { BROWSERBASE_API_KEY: "", BROWSERBASE_PROJECT_ID: "", GEMINI_API_KEY: "" },
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
      key: "GEMINI_API_KEY",
      label: "Gemini API key (Stagehand model)",
      placement: "env",
      secret: true,
      description:
        "Stagehand v3 defaults to google/gemini-2.5-flash-lite. Pass --modelName to the server to use a different provider.",
    },
  ],
  runtime: "both",
  docsUrl: "https://github.com/browserbase/mcp-server-browserbase",
  tags: ["web", "browser", "ai-native"],
})

const definition: PluginDefinition = {
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here would WIN and silently drop `commands[]`.
  manifest: {
    ...(manifestJson as object),
    mcpServerPresets: [STAGEHAND_PRESET],
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("stagehand-mcp plugin activated")

    ctx.agent?.registerMcpServerPreset?.(STAGEHAND_PRESET)

    // The slash command is DECLARED in plugin.json (`commands[]`) and handled
    // here — the supported shape per the author-SDK migration table. The
    // manager owns registration (namespaced id, conflict detection, aliases,
    // command-palette entry, idle-clock refresh) and teardown.
    return {
      onCommand: async (command: string) => {
        if (command !== "stagehand") return false
        ctx.ui?.showToast?.(
          "Open Settings → MCP Servers, click Stagehand in the gallery, fill in the Browserbase + Gemini keys, then attach it to the current character.",
          "info"
        )
        return true
      },
    }
  },
}

export default definition
