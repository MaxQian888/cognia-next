/**
 * Cognia frontend plugin template (TypeScript).
 *
 * One activation, showing the shapes an author reaches for first:
 *
 *   - an agent tool (`ctx.agent.registerTool`)
 *   - a manifest slash command answered through `hooks.onCommand`
 *   - a quick action, contributed declaratively in `plugin.json` so the
 *     palette, the composer menu and the tray dispatch the same command
 *   - a UI slot contribution (`ctx.extensions.registerExtension`)
 *   - the plugin's own settings (`ctx.settings`, schema in `plugin.json`)
 *   - durable state (`ctx.storage`)
 *   - a workflow node and a trigger source (`ctx.workflow`)
 *   - teardown registered on the activation generation (`ctx.lifecycle`)
 *
 * Everything here compiles against `@cognia/plugin-sdk` alone. No host-private
 * module is imported, which is exactly the boundary a published plugin has.
 */

import {
  definePlugin,
  type ExtensionProps,
  type PluginContext,
  type PluginTriggerStartContext,
  type StepExecutionContext,
} from "@cognia/plugin-sdk"
import { TemplatePanel } from "./panel"

interface EchoArgs {
  message?: string
}

/** Key the tool's call counter is persisted under. */
const ECHO_COUNT_KEY = "echoCount"

const TRANSLATIONS = {
  en: {
    "panel.status.static": "Static",
    "panel.status.live": "Live",
    "panel.clicked": "Clicked {count}",
    "action.greet": "Template Greet",
  },
  "zh-CN": {
    "panel.status.static": "静态",
    "panel.status.live": "实时",
    "panel.clicked": "已点击 {count} 次",
    "action.greet": "模板问候",
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
    // plugin.json), not by a capability. Every other entry here has a matching
    // contribution block in plugin.json. A declared capability whose field is
    // empty is exactly what `cognia plugin lint` reports as dormant.
    // Must stay identical to `plugin.json`'s list: the host merges the module's
    // manifest OVER the file's, so a tag missing here is a tag the running
    // plugin does not claim, however the manifest reads on disk. `workflow` and
    // `workflow-trigger` are two tags because they are two contribution blocks,
    // and `activate` registers one of each.
    capabilities: [
      "tools",
      "commands",
      "quick-action",
      "configuration",
      "workflow",
      "workflow-trigger",
    ],
    main: "dist/index.js",
    // Plain CSS, shipped from src/ rather than dist/ because nothing compiles
    // it, and `cognia plugin build` errors on a `bundle_include` entry that
    // does not exist yet.
    styles: "src/panel.css",
  },

  activate: async (ctx: PluginContext) => {
    ctx.logger.info("template-ts plugin activated")
    for (const [locale, messages] of Object.entries(TRANSLATIONS)) {
      ctx.i18n.registerTranslations(locale as "en" | "zh-CN", messages)
    }

    /**
     * Settings declared as `configSchema` in `plugin.json`. Read per use rather
     * than cached: the user can change a value while the plugin runs, which is
     * what `onChange` is for. The `??` is not decoration. A user who never
     * opened the settings page has no stored value, and the schema default is
     * not backfilled into storage.
     */
    const readGreetingPrefix = () => ctx.settings.get<string>("greetingPrefix") ?? "Hello"
    const readShoutEcho = () => ctx.settings.get<boolean>("shoutEcho") ?? false

    /**
     * Anything registered during activation has to come back off on deactivate.
     * `ctx.lifecycle.onDispose` runs the ledger in LIFO order for THIS
     * activation generation, so a reload cannot leak the previous generation's
     * registrations, which a hand-kept array in module scope would.
     */
    const disposeOn = (dispose: () => void, label: string) =>
      ctx.lifecycle.onDispose(dispose, label)

    disposeOn(
      ctx.settings.onChange("greetingPrefix", (value) => {
        ctx.logger.debug("greeting prefix changed", { value })
      }),
      "settings:greetingPrefix"
    )

    // Mount a component into a host UI slot. The host wraps it in an error
    // boundary and in `data-plugin-root`, which is what bounds `manifest.styles`
    // to this plugin's subtree. `formFactor` arrives as a prop, so read it
    // rather than assuming: the same component may be mounted into a 28px
    // status bar and into a full side panel.
    disposeOn(
      ctx.extensions.registerExtension(
        "chat.input.actions",
        (props: ExtensionProps) => TemplatePanel({ ...props, ctx }),
        { priority: 0 }
      ),
      "extension:chat.input.actions"
    )

    disposeOn(
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
          // `ctx.storage` is this plugin's own namespaced, durable store. It
          // survives reload and update, which module scope does not.
          const calls = ((await ctx.storage.get<number>(ECHO_COUNT_KEY)) ?? 0) + 1
          await ctx.storage.set(ECHO_COUNT_KEY, calls)
          return {
            ok: true,
            echoed: readShoutEcho() ? message.toUpperCase() : message,
            calls,
          }
        },
      }),
      "tool:template_echo"
    )

    /**
     * A workflow node. `kind` is UNPREFIXED here, because the host namespaces
     * it to `action.<pluginId>.echo` so two plugins can both ship an
     * `action.echo`. The catalog half (label, icon, params schema) is also in
     * `plugin.json`, so the node appears in the editor before this plugin has
     * ever been activated. This is the executor the orchestrator calls.
     */
    disposeOn(
      ctx.workflow.registerNode({
        kind: "action.echo",
        typeVersion: 1,
        category: "plugin",
        label: "Template Echo",
        description: "Echo its input downstream. Replace with your own node.",
        iconName: "Repeat",
        paramsSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
        defaultParams: { message: "" },
        execute: async (step: StepExecutionContext) => {
          const message = String(step.params?.message ?? "")
          step.log("info", "template echo", { length: message.length })
          return { output: { message } }
        },
      }),
      "workflow:node:action.echo"
    )

    /**
     * A trigger source. `start` runs once per workflow binding and returns a
     * handle whose `stop()` must be idempotent. The context's `signal` aborts
     * on teardown, which is what keeps the interval below from outliving the
     * plugin even if the host never calls `stop`.
     */
    disposeOn(
      ctx.workflow.registerTrigger({
        kind: "trigger.ticker",
        typeVersion: 1,
        label: "Template Ticker",
        description: "Emit one event every N seconds. Replace with your own trigger source.",
        iconName: "Timer",
        paramsSchema: {
          type: "object",
          properties: { intervalMs: { type: "number", minimum: 1000 } },
          additionalProperties: false,
        },
        defaultParams: { intervalMs: 60000 },
        start: async (trigger: PluginTriggerStartContext) => {
          const intervalMs = Math.max(1000, Number(trigger.params?.intervalMs ?? 60000))
          const timer = setInterval(() => {
            trigger.emit({ at: Date.now(), workflowId: trigger.workflowId })
          }, intervalMs)
          const stop = () => clearInterval(timer)
          trigger.signal.addEventListener("abort", stop, { once: true })
          return { stop }
        },
      }),
      "workflow:trigger:trigger.ticker"
    )

    return {
      onCommand: async (command, args) => {
        if (command !== "template-greet") return false
        const subject = args.join(" ").trim() || "world"
        const greeting = `${readGreetingPrefix()}, ${subject}!`
        ctx.ui.showToast(greeting, "success")
        // Returning a result rather than `true` owns the chat response, and
        // `message` is inserted verbatim as markdown. Plain `true` leaves the
        // host to print its own generic "Command handled by plugin" line.
        return { handled: true, message: greeting }
      },

      // Fired when the user edits this plugin's settings. Cheap here, but the
      // point is that anything derived from config has one place to invalidate.
      onConfigChange: (config: Record<string, unknown>) => {
        ctx.logger.debug("template-ts config changed", { keys: Object.keys(config) })
      },
    }
  },

  deactivate: async (ctx?: PluginContext) => {
    // Registrations are torn down by the lifecycle ledger above, so this is
    // only for state the ledger cannot know about.
    ctx?.logger.info("template-ts plugin deactivated")
  },
})

export default definition
