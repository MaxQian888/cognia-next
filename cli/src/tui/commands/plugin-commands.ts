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
    description: "list, inspect, enable, or disable plugins",
    category: "plugin",
    handler: rt("plugin", "list"),
    subcommands: [
      { name: "list", description: "browse installed plugins", handler: rt("plugin", "list") },
      { name: "show", description: "inspect a plugin by id", handler: rt("plugin", "show") },
      {
        name: "tools",
        description: "show a plugin's declared tools by id",
        argumentHint: "<id>",
        handler: rt("plugin", "tools"),
      },
      { name: "enable", description: "enable a plugin by id", handler: rt("plugin", "enable") },
      { name: "disable", description: "disable a plugin by id", handler: rt("plugin", "disable") },
    ],
  },
]
