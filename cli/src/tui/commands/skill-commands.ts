/**
 * Slash-command descriptors for skills (`/skill`). Handlers are pure — they emit
 * `runtime` effects the App routes to the skill controller.
 */
import { rt } from "./runtime-handler"
import type { CommandDescriptor } from "./types"

export const SKILL_COMMANDS: CommandDescriptor[] = [
  {
    name: "skill",
    description: "list, show, enable, or disable skills",
    category: "config",
    handler: rt("skill", "list"),
    subcommands: [
      { name: "list", description: "browse skills", handler: rt("skill", "list") },
      {
        name: "show",
        description: "show a skill's full detail by id",
        handler: rt("skill", "show"),
      },
      {
        name: "files",
        description: "browse a skill's bundled files by id",
        argumentHint: "<id>",
        handler: rt("skill", "files"),
      },
      { name: "enable", description: "enable a skill by id", handler: rt("skill", "enable") },
      { name: "disable", description: "disable a skill by id", handler: rt("skill", "disable") },
      { name: "toggle", description: "toggle a skill by id", handler: rt("skill", "toggle") },
    ],
  },
]
