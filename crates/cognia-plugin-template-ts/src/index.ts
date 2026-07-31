/**
 * Cognia frontend plugin template (TypeScript).
 *
 * Demonstrates a synchronous agent tool and a manifest-declared slash command
 * without importing any host-private module.
 */

import {
  definePlugin,
  type ExtensionProps,
  type FullPluginContext,
  type PluginContext,
} from "@cognia/plugin-sdk"
import { TemplatePanel } from "./panel"

/**
 * `PluginDefinition.activate` is declared against the narrow `PluginContext`,
 * but the host always constructs and passes a `FullPluginContext` — that is
 * where `extensions`, `theme` and the other v2 namespaces live. Narrow once
 * here rather than optional-chaining every call site.
 */
const full = (ctx: PluginContext): FullPluginContext => ctx as unknown as FullPluginContext

interface EchoArgs {
  message?: string
}

const TRANSLATIONS = {
  en: {
    "panel.status.static": "Static",
    "panel.status.live": "Live",
    "panel.clicked": "Clicked {count}",
  },
  "zh-CN": {
    "panel.status.static": "静态",
    "panel.status.live": "实时",
    "panel.clicked": "已点击 {count} 次",
  },
} as const

const definition = definePlugin({
  manifest: {
    id: "cognia-plugin-template-ts",
    name: "Cognia Plugin Template TS",
    version: "0.1.0",
    description: "Cognia frontend TypeScript plugin template",
    type: "frontend",
    // UI slot contributions are gated by the `extension:ui` PERMISSION (see
    // plugin.json) — there is no separate capability for them.
    capabilities: ["tools", "commands"],
    main: "dist/index.js",
    // Plain CSS — shipped from src/ rather than dist/ because nothing compiles
    // it, and `cognia plugin build` errors on a `bundle_include` entry that
    // does not exist yet.
    styles: "src/panel.css",
  },

  activate: async (ctx: PluginContext) => {
    ctx.logger.info("template-ts plugin activated")
    for (const [locale, messages] of Object.entries(TRANSLATIONS)) {
      full(ctx).i18n.registerTranslations(locale as "en" | "zh-CN", messages)
    }

    // Mount a component into a host UI slot. The host wraps it in an error
    // boundary and in `data-plugin-root`, which is what bounds `manifest.styles`
    // to this plugin's subtree. `formFactor` arrives as a prop — read it rather
    // than assuming, because the same component may be mounted into a 28px
    // status bar and a full side panel.
    full(ctx).extensions.registerExtension(
      "chat.input.actions",
      (props: ExtensionProps) => TemplatePanel({ ...props, ctx: full(ctx) }),
      { priority: 0 }
    )

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
