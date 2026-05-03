/**
 * Prompt Templates — built-in plugin.
 *
 * Stores user-defined prompt templates inside the plugin's storage
 * namespace and exposes them as slash commands so the user can paste them
 * into the chat with a single keystroke. Reuses
 * `lib/chat/slash-command-registry` rather than rolling its own dispatch
 * surface so the templates show up in the same command palette as
 * built-in commands.
 *
 * Slash commands:
 *   /template <name>            — insert the template body
 *   /template-add <name> <body> — store a new template
 *   /template-remove <name>     — delete a template
 *   /template-list              — list the available templates
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/chat/slash-command-registry"

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
  manifest: {
    id: "cognia-prompt-templates",
    name: "Prompt Templates",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["commands"],
    main: "src/index.ts",
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("prompt-templates activated")

    registerSlashCommand({
      id: "template",
      name: "/template",
      description: "Insert a stored prompt template by name.",
      source: "plugin",
      pluginId: ctx.pluginId,
      handler: async (args) => {
        const name = args.trim()
        if (!name) {
          return { message: "Usage: /template <name>" }
        }
        const body = await readTemplate(ctx, name)
        if (!body) {
          return { message: `Template "${name}" not found.` }
        }
        return { message: body }
      },
    })

    registerSlashCommand({
      id: "template-add",
      name: "/template-add",
      description: "Store a new prompt template.",
      source: "plugin",
      pluginId: ctx.pluginId,
      handler: async (args) => {
        const parsed = parseAdd(args)
        if (!parsed) {
          return { message: "Usage: /template-add <name> <body>" }
        }
        await storeTemplate(ctx, parsed.name, parsed.body)
        return { message: `Saved template "${parsed.name}".` }
      },
    })

    registerSlashCommand({
      id: "template-remove",
      name: "/template-remove",
      description: "Delete a prompt template by name.",
      source: "plugin",
      pluginId: ctx.pluginId,
      handler: async (args) => {
        const name = args.trim()
        if (!name) {
          return { message: "Usage: /template-remove <name>" }
        }
        await deleteTemplate(ctx, name)
        return { message: `Removed template "${name}".` }
      },
    })

    registerSlashCommand({
      id: "template-list",
      name: "/template-list",
      description: "List the templates this plugin has stored.",
      source: "plugin",
      pluginId: ctx.pluginId,
      handler: async () => {
        const list = await listTemplates(ctx)
        if (list.length === 0) {
          return { message: "No prompt templates saved yet." }
        }
        return { message: list.map((n) => `• ${n}`).join("\n") }
      },
    })
  },
  deactivate: async (ctx?: PluginContext) => {
    if (ctx?.pluginId) {
      unregisterCommandsByPlugin(ctx.pluginId)
    }
  },
}

export default definition
