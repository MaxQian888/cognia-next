/**
 * Cognia frontend plugin template (TypeScript).
 *
 * Demonstrates a synchronous agent tool and a manifest-declared slash command
 * without importing any host-private module.
 */

import { definePlugin, type PluginContext } from "@cognia/plugin-sdk"

interface EchoArgs {
  message?: string
}

const definition = definePlugin({
  manifest: {
    id: "cognia-plugin-template-ts",
    name: "Cognia Plugin Template TS",
    version: "0.1.0",
    description: "Cognia frontend TypeScript plugin template",
    type: "frontend",
    capabilities: ["tools", "commands"],
    main: "dist/index.js",
  },

  activate: async (ctx: PluginContext) => {
    ctx.logger.info("template-ts plugin activated")

    ctx.agent.registerTool({
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
      },
      execute: async (args: EchoArgs) => {
        const message = typeof args?.message === "string" ? args.message : ""
        return { ok: true, echoed: message }
      },
    })

    return {
      onCommand: async (command, args) => {
        if (command !== "template-greet") return false
        const subject = args.join(" ").trim() || "world"
        ctx.ui.showToast(`Hello, ${subject}!`, "success")
        return true
      },
    }
  },

  deactivate: async (ctx?: PluginContext) => {
    ctx?.logger.info("template-ts plugin deactivated")
  },
})

export default definition
