/**
 * `/stack` — stacked branches from the terminal.
 *
 * Pure descriptor; every verb routes to the `stack` runtime controller. The
 * record it reads and writes is `branch.<name>.cognia-parent` in the
 * repository's own config, which is the same key the desktop app uses — a
 * chain built here appears in the Stacks panel and vice versa.
 */
import { rt } from "./runtime-handler"
import type { CommandDescriptor } from "./types"

export const stackCommand: CommandDescriptor = {
  name: "stack",
  description: "show the stacked branch chains recorded in this repository",
  category: "cognia",
  handler: rt("stack", "list"),
  subcommands: [
    {
      name: "on",
      description: "record the branch this one is stacked on",
      handler: rt("stack", "on"),
    },
    {
      name: "off",
      description: "clear this branch's parent, making it a bottom layer",
      handler: rt("stack", "off"),
    },
    {
      name: "check",
      description: "verify every layer really contains its parent",
      handler: rt("stack", "check"),
    },
    {
      name: "restack",
      description: "replay each layer onto the one below it",
      handler: rt("stack", "restack"),
    },
    {
      name: "push",
      description: "push every layer with a lease",
      handler: rt("stack", "push"),
    },
  ],
}
