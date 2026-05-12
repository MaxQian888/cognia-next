/**
 * E2B Sandbox plugin — contributes an E2B MCP server preset to
 * cognia-next's MCP gallery.
 *
 * E2B runs each code-execution in its own Firecracker microVM (the same
 * virtualization tech behind AWS Lambda), which is the safest way to
 * have a model write+run untrusted code without touching the host. Useful
 * for Computer Use isolation, code interpretation, and data-analysis
 * workflows.
 *
 * Wrapper tools for the ai-sdk runtime path (e2b.run_python /
 * e2b.run_node) are deferred — the MCP preset already covers both
 * runtimes via the M2 bridge once it lands.
 *
 * Part of M3 of the plugin-first Computer Use plan.
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { defineMcpServerPreset } from "@/lib/plugin/sdk"
import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/chat/slash-command-registry"

const E2B_PRESET = defineMcpServerPreset({
  id: "e2b-sandbox",
  name: "E2B Sandbox",
  description:
    "Run code in ephemeral Firecracker microVM sandboxes — Python, Node, shell, file ops. Untrusted-code safe.",
  icon: "📦",
  transport: "stdio",
  config: {
    command: "npx",
    args: ["-y", "@e2b/mcp-server"],
    env: { E2B_API_KEY: "" },
  },
  fields: [
    {
      key: "E2B_API_KEY",
      label: "E2B API key",
      placement: "env",
      secret: true,
      description: "Get one at e2b.dev.",
    },
  ],
  runtime: "both",
  docsUrl: "https://github.com/e2b-dev/mcp-server",
  tags: ["sandbox", "code", "execution"],
})

const definition: PluginDefinition = {
  manifest: {
    id: "cognia-e2b-sandbox",
    name: "E2B Sandbox",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["mcp-server-preset", "commands"],
    main: "src/index.ts",
    mcpServerPresets: [E2B_PRESET],
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("e2b-sandbox plugin activated")

    ctx.agent?.registerMcpServerPreset?.(E2B_PRESET)

    registerSlashCommand({
      id: "e2b.attach",
      name: "/sandbox",
      description: "Attach the E2B sandbox MCP to the current character.",
      handler: () => ({
        message:
          "Open Settings → MCP Servers, click E2B Sandbox in the gallery, paste your E2B API key, then attach it to the current character.",
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
