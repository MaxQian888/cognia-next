/**
 * Cognia frontend plugin template (TypeScript).
 *
 * Demonstrates the two most common contribution points:
 *   - a synchronous agent tool (`template_echo`)
 *   - a slash command (`/template-greet`)
 *
 * Copy this file as the starting point for your own plugin. The host loads
 * `dist/index.js` (the esbuild output), not this source file, so make sure
 * `pnpm build` runs before packaging.
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"

/**
 * Arguments accepted by the `template_echo` tool.
 */
interface EchoArgs {
  message?: string
}

const definition: PluginDefinition = {
  // The runtime treats `plugin.json` as the source of truth for manifest
  // fields; the inline manifest here is a development-time hint so unit
  // tests and TS callers can introspect the plugin without re-reading the
  // JSON. Keep the two in sync.
  manifest: {
    id: "cognia-plugin-template-ts",
    name: "Cognia Plugin Template TS",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["tools", "commands"],
    main: "dist/index.js",
  } as never,

  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("template-ts plugin activated")

    // ── Tool: template_echo ──────────────────────────────────────────────
    ctx.agent?.registerTool?.({
      name: "template_echo",
      pluginId: ctx.pluginId,
      definition: {
        name: "template_echo",
        description: "Echo the supplied message back to the agent.",
        parametersSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "The message to echo.",
            },
          },
          required: ["message"],
          additionalProperties: false,
        },
      } as never,
      execute: async (args: EchoArgs) => {
        const message = typeof args?.message === "string" ? args.message : ""
        return { ok: true, echoed: message }
      },
    })

    // ── Slash command: /template-greet ───────────────────────────────────
    const { registerSlashCommand } = await import("@/lib/chat/slash-command-registry")
    registerSlashCommand({
      id: "template-greet",
      name: "Template Greet",
      description: "Print a greeting back to the chat.",
      pluginId: ctx.pluginId,
      handler: async (argString: string) => {
        const subject = argString.trim().length > 0 ? argString.trim() : "world"
        return { message: `Hello, ${subject}!` }
      },
    } as never)
  },

  deactivate: async (ctx?: PluginContext) => {
    // Slash commands registered with `pluginId` are auto-unregistered by the
    // host when the plugin deactivates; tools follow the same rule. We
    // still call the unregister helper defensively in case the host
    // skipped the sweep (e.g. forced reload).
    try {
      const { unregisterCommandsByPlugin } = await import("@/lib/chat/slash-command-registry")
      unregisterCommandsByPlugin(ctx?.pluginId ?? "cognia-plugin-template-ts")
    } catch {
      // The host may have torn down the registry already; that's fine.
    }
  },
}

export default definition
