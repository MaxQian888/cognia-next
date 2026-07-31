/**
 * Slash-command descriptors for skills (`/skill`). Handlers are pure — they emit
 * `runtime` effects the App routes to the skill controller.
 */
import { rt } from "./runtime-handler"
import type { CommandArgSpec, CommandDescriptor } from "./types"

const CREATE_ARGS: CommandArgSpec[] = [
  { name: "name", label: "Name", type: "string", required: true },
  {
    name: "description",
    label: "Description",
    type: "string",
    placeholder: "what it does / when to use",
  },
]

export const SKILL_COMMANDS: CommandDescriptor[] = [
  {
    name: "skill",
    description: "manage skills (browse, toggle, create)",
    category: "config",
    handler: rt("skill", "panel"),
    subcommands: [
      {
        name: "panel",
        description: "open the interactive skills panel",
        handler: rt("skill", "panel"),
      },
      { name: "list", description: "browse skills (text list)", handler: rt("skill", "list") },
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
      {
        name: "enable-all",
        description: "enable every discovered skill for the session",
        handler: rt("skill", "enable-all"),
      },
      {
        name: "disable-all",
        description: "disable every discovered skill for the session",
        handler: rt("skill", "disable-all"),
      },
      { name: "toggle", description: "toggle a skill by id", handler: rt("skill", "toggle") },
      {
        name: "create",
        description: "scaffold a new custom skill",
        args: CREATE_ARGS,
        handler: rt("skill", "create"),
      },
      {
        name: "delete",
        description: "delete a custom skill by id",
        argumentHint: "<id>",
        handler: rt("skill", "delete"),
      },
    ],
  },
]
