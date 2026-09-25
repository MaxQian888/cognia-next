/**
 * Prompt Templates — built-in plugin.
 *
 * Stores user-defined prompt templates inside the plugin's storage namespace
 * (`template-store.ts`) and surfaces them two ways: as slash commands, and as
 * a Context Workbench panel on the chat right rail's `templates` activity.
 *
 * Using a template puts its body into the composer — verbatim, newlines and
 * all — through `ctx.chat.appendToComposer`, targeted at the chat the command
 * was typed in (or, from the panel, the chat whose workbench it sits in). The
 * body always comes from storage: `/template <name>` never re-assembles text
 * from the command's argv.
 *
 * Slash commands:
 *   /template <name>            — insert the template into the composer
 *   /template-add <name> <body> — store a new template
 *   /template-remove <name>     — delete a template
 *   /template-list              — list the available templates
 *
 * `/template-add` reads the body from `context.rawArgs` — the text as typed —
 * so a multi-line body keeps its line breaks and indentation. The split argv
 * is only the fallback for a host that does not forward it.
 */

import {
  definePlugin,
  definePluginManifest,
  type PluginCommandContext,
  type PluginContext,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { createTemplateStore } from "./template-store"
import { createTemplatesPanel } from "./templates-panel"

export const manifest = definePluginManifest(manifestJson)

const PANEL_ID = "templates"

/**
 * Split `/template-add` input into the name and the body. With the raw text
 * the body is everything after the first word, verbatim (only the separating
 * whitespace and trailing blank space are dropped); without it the argv tail
 * is space-joined.
 */
export function parseAdd(argv: string[], rawArgs?: string): { name: string; body: string } | null {
  if (rawArgs !== undefined) {
    const match = /^\s*(\S+)\s+([\s\S]*?)\s*$/.exec(rawArgs)
    if (!match || !match[2]) return null
    return { name: match[1]!, body: match[2] }
  }
  const [name, ...rest] = argv
  const body = rest.join(" ").trim()
  if (!name?.trim() || !body) return null
  return { name: name.trim(), body }
}

const definition = definePlugin({
  manifest,
  activate: async (ctx: PluginContext) => {
    ctx.logger.info("prompt-templates activated")
    const t = (key: string, params?: Record<string, string | number>) => ctx.i18n.t(key, params)
    const store = createTemplateStore(ctx.storage)

    // The chat right rail's `templates` activity has no native panel, so this
    // is the surface a user browses their saved templates from. Registered on
    // the `session` resource: that is the dock's fallback when no artifact is
    // open, i.e. the rail's default state. `label` is the fallback for
    // `labelKey`, which resolves from plugin.json's i18n bundle.
    const disposePanel = ctx.contextPanels.register({
      id: PANEL_ID,
      activity: "templates",
      label: t("panel.label"),
      labelKey: "panel.label",
      resourceKinds: ["session"],
      icon: "FileText",
      order: 20,
      retention: "stateful",
      renderer: createTemplatesPanel(ctx, store),
    })
    ctx.lifecycle.onDispose(disposePanel, "prompt-templates:panel")

    // Pushed rather than declared via `getBadge`: the count only changes when a
    // command writes storage, which happens outside any render. (The two are
    // additive in the registry, so using both would double-count.)
    const refreshBadge = async () => {
      ctx.contextPanels.setBadge(PANEL_ID, (await store.list()).length)
    }
    ctx.lifecycle.onDispose(
      store.subscribe(() => {
        refreshBadge().catch((error: unknown) =>
          ctx.logger.warn(`prompt-templates: badge refresh failed: ${String(error)}`)
        )
      }),
      "prompt-templates:badge"
    )
    await refreshBadge()

    // All four commands are DECLARED in plugin.json (`commands[]`) and handled
    // here; the manager owns registration and teardown. Each answers with a
    // localized message the host posts into the originating chat.
    return {
      onCommand: async (command: string, argv: string[], context?: PluginCommandContext) => {
        const say = (key: string, params?: Record<string, string | number>) => ({
          handled: true,
          message: t(key, params),
        })
        switch (command) {
          case "template": {
            const name = argv.join(" ").trim()
            if (!name) return say("command.templateUsage")
            const body = await store.read(name)
            if (body === undefined) return say("command.notFound", { name })
            ctx.chat.appendToComposer(
              body,
              context?.sessionId ? { sessionId: context.sessionId } : undefined
            )
            return say("command.inserted", { name })
          }
          case "template-add": {
            const parsed = parseAdd(argv, context?.rawArgs)
            if (!parsed) return say("command.addUsage")
            await store.save(parsed.name, parsed.body)
            return say("command.saved", { name: parsed.name })
          }
          case "template-remove": {
            const name = argv.join(" ").trim()
            if (!name) return say("command.removeUsage")
            // Report the truth: a name that never existed is "not found",
            // not "removed".
            if (!(await store.remove(name))) return say("command.notFound", { name })
            return say("command.removed", { name })
          }
          case "template-list": {
            const names = await store.list()
            if (names.length === 0) return say("command.listEmpty")
            return {
              handled: true,
              message: `${t("command.listHeader", { count: names.length })}\n\n${names
                .map((name) => `- ${name}`)
                .join("\n")}`,
            }
          }
          default:
            return false
        }
      },
    }
  },
})

export default definition
