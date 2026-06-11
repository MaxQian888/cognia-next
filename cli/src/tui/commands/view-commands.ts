/**
 * Slash-command descriptor for the file viewer (`/view <path>`). Pure handler —
 * emits a `runtime` effect the App routes to the view controller, which reads the
 * file and opens the scrollable document viewer.
 */
import { rt } from "./runtime-handler"
import type { CommandDescriptor } from "./types"

export const VIEW_COMMANDS: CommandDescriptor[] = [
  {
    name: "view",
    aliases: ["cat"],
    description: "open a file in the scrollable viewer (markdown or highlighted text)",
    category: "system",
    argumentHint: "<path>",
    handler: rt("view", "open"),
  },
]
