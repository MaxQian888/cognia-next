/**
 * Slash-command descriptors for plugins (`/plugin`). Handlers are pure — they
 * emit `runtime` effects the App routes to the plugin controller.
 */
import { rt } from "./runtime-handler"
import type { CommandDescriptor } from "./types"

export const PLUGIN_COMMANDS: CommandDescriptor[] = [
  {
    name: "plugin",
    aliases: ["plugins"],
    description: "list, inspect, install, reload, or remove plugins, and browse the marketplace",
    category: "plugin",
    handler: rt("plugin", "list"),
    subcommands: [
      { name: "list", description: "browse installed plugins", handler: rt("plugin", "list") },
      {
        name: "show",
        description: "inspect a plugin by id",
        argumentHint: "<id>",
        handler: rt("plugin", "show"),
      },
      {
        name: "tools",
        description: "show a plugin's declared tools by id",
        argumentHint: "<id>",
        handler: rt("plugin", "tools"),
      },
      {
        name: "enable",
        description: "enable a plugin by id",
        argumentHint: "<id>",
        handler: rt("plugin", "enable"),
      },
      {
        name: "disable",
        description: "disable a plugin by id",
        argumentHint: "<id>",
        handler: rt("plugin", "disable"),
      },
      {
        name: "reload",
        description: "hot-reload a plugin by id",
        argumentHint: "<id>",
        handler: rt("plugin", "reload"),
      },
      {
        name: "install",
        description: "install a plugin from a GitHub repo",
        argumentHint: "<owner/repo[@ref][/subdir]>",
        handler: rt("plugin", "install"),
      },
      {
        name: "preview",
        description: "preview a marketplace plugin (README + permissions) before installing",
        argumentHint: "<owner/repo[@ref][/subdir]>",
        handler: rt("plugin", "preview"),
      },
      {
        name: "update",
        description: "update a GitHub-installed plugin (no id checks all for updates)",
        argumentHint: "[id]",
        handler: rt("plugin", "update"),
      },
      {
        name: "uninstall",
        description: "remove an installed plugin by id",
        argumentHint: "<id>",
        handler: rt("plugin", "uninstall"),
      },
      {
        name: "marketplace",
        description: "browse the marketplace, or manage sources (add|list|remove)",
        argumentHint: "[add|list|remove] [owner/repo]",
        handler: rt("plugin", "marketplace"),
      },
      {
        name: "sources",
        description: "manage GitHub marketplace sources (add|remove|list)",
        argumentHint: "<add|remove|list> [owner/repo]",
        handler: rt("plugin", "sources"),
      },
      {
        name: "trust",
        description: "manage trusted GitHub publishers (add|remove|list)",
        argumentHint: "<add|remove|list> [owner]",
        handler: rt("plugin", "trust"),
      },
    ],
  },
]
