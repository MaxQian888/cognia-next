/**
 * Prompt Templates — built-in plugin.
 *
 * Stores user-defined prompt templates inside the plugin's storage namespace
 * and surfaces them two ways: as slash commands, and as a Context Workbench
 * panel on the chat right rail's `templates` activity. Reuses
 * `lib/slash-commands/registry` rather than rolling its own dispatch
 * surface so the templates show up in the same command palette as
 * built-in commands.
 *
 * Neither surface inserts into the composer — no plugin API can write to it —
 * so both hand the body back for the user to place: the command shows it, the
 * panel copies it.
 *
 * Slash commands:
 *   /template <name>            — show the template body
 *   /template-add <name> <body> — store a new template
 *   /template-remove <name>     — delete a template
 *   /template-list              — list the available templates
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { createTemplatesPanel } from "./templates-panel"
import manifestJson from "../plugin.json"

const KEY_PREFIX = "template:"

async function storeTemplate(ctx: PluginContext, name: string, body: string): Promise<void> {
  await ctx.storage?.set?.(`${KEY_PREFIX}${name}`, body)
}

async function readTemplate(ctx: PluginContext, name: string): Promise<string | undefined> {
  return ctx.storage?.get?.<string>(`${KEY_PREFIX}${name}`)
}

async function deleteTemplate(ctx: PluginContext, name: string): Promise<void> {
  await ctx.storage?.remove?.(`${KEY_PREFIX}${name}`)
}

async function listTemplates(ctx: PluginContext): Promise<string[]> {
  const keys = (await ctx.storage?.keys?.()) ?? []
  return keys
    .filter((k) => k.startsWith(KEY_PREFIX))
    .map((k) => k.slice(KEY_PREFIX.length))
    .sort()
}

function parseAdd(args: string): { name: string; body: string } | null {
  const trimmed = args.trim()
  const sep = trimmed.indexOf(" ")
  if (sep === -1) return null
  const name = trimmed.slice(0, sep).trim()
  const body = trimmed.slice(sep + 1).trim()
  if (!name || !body) return null
  return { name, body }
}

const definition: PluginDefinition = {
  // Spread plugin.json: `builtinManifest()` merges module-over-JSON, so a
  // hand-written subset here WINS and would silently drop `commands[]`.
  manifest: {
    ...(manifestJson as object),
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("prompt-templates activated")

    // The chat right rail's `templates` activity has no native panel, so this
    // is the surface a user browses their saved templates from. Registered on
    // the `session` resource: that is the dock's fallback when no artifact is
    // open, i.e. the rail's default state.
    const disposePanel = ctx.contextPanels?.register?.({
      id: "templates",
      activity: "templates",
      label: "Prompt Templates",
      labelKey: "panel.templates",
      resourceKinds: ["session"],
      icon: "FileText",
      order: 20,
      retention: "stateful",
      renderer: createTemplatesPanel(ctx),
    })
    // Pushed rather than declared via `getBadge`: the count only changes when a
    // slash command writes storage, which happens outside any render. (The two
    // are additive in the registry, so using both would double-count.)
    const refreshBadge = async () => {
      ctx.contextPanels?.setBadge?.("templates", (await listTemplates(ctx)).length)
    }
    await refreshBadge()

    // All four commands are DECLARED in plugin.json (`commands[]`) and handled
    // here — the supported shape per the author-SDK migration table. The
    // manager owns registration (namespaced ids, conflict detection, aliases,
    // command-palette entries, idle-clock refresh) and teardown.
    //
    // `hooks.onCommand` hands over whitespace-split argv, so the raw tail is
    // rejoined for the handlers that parse their own argument string.
    return {
      onCommand: async (command: string, argv: string[]) => {
        const args = argv.join(" ")
        const say = (message: string): true => {
          ctx.ui?.showToast?.(message, "info")
          return true
        }
        switch (command) {
          case "template": {
            const name = args.trim()
            if (!name) return say("Usage: /template <name>")
            const body = await readTemplate(ctx, name)
            return say(body ? body : `Template "${name}" not found.`)
          }
          case "template-add": {
            const parsed = parseAdd(args)
            if (!parsed) return say("Usage: /template-add <name> <body>")
            await storeTemplate(ctx, parsed.name, parsed.body)
            await refreshBadge()
            return say(`Saved template "${parsed.name}".`)
          }
          case "template-remove": {
            const name = args.trim()
            if (!name) return say("Usage: /template-remove <name>")
            // Report the truth: this used to answer `Removed template "x"` for
            // a name that never existed.
            const existing = await readTemplate(ctx, name)
            if (!existing) return say(`Template "${name}" not found.`)
            await deleteTemplate(ctx, name)
            await refreshBadge()
            return say(`Removed template "${name}".`)
          }
          case "template-list": {
            const list = await listTemplates(ctx)
            return say(
              list.length === 0
                ? "No prompt templates saved yet."
                : list.map((n) => `• ${n}`).join("\n")
            )
          }
          default:
            return false
        }
      },
      onDeactivate: () => disposePanel?.(),
    }
  },
}

export default definition
