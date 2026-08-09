/**
 * Slash-command descriptor for the file viewer (`/view <path>`). Pure handler —
 * emits a `runtime` effect the App routes to the view controller, which reads the
 * file and opens the scrollable document viewer.
 */
import { rt } from "./runtime-handler"
import type { CommandDescriptor } from "./types"
import { validateA2UISurface } from "../a2ui/surface"
import { sanitizeTerminalText } from "../render/terminal-block"

const openFile = rt("view", "open")

export const VIEW_COMMANDS: CommandDescriptor[] = [
  {
    name: "view",
    aliases: ["cat"],
    description: "open a file in the scrollable viewer (markdown or highlighted text)",
    category: "system",
    argumentHint: "<path>",
    handler: (ctx) => {
      const target = ctx.args.trim()
      const cell = ctx.state.cells.find(
        (candidate) => candidate.kind === "content-part" && candidate.partId === target
      )
      if (!cell || cell.kind !== "content-part") return openFile(ctx)
      if (cell.part.type === "a2ui") {
        const validated = validateA2UISurface(cell.part.surfaceId, cell.part.payload)
        return validated.ok
          ? { kind: "openOverlay", overlay: { kind: "a2ui", surface: validated.surface } }
          : { kind: "notice", message: `Cannot open A2UI surface: ${validated.reason}` }
      }
      let body: string
      try {
        body = sanitizeTerminalText(JSON.stringify(cell.part, null, 2))
      } catch {
        body = "Structured content is unavailable."
      }
      return {
        kind: "openOverlay",
        overlay: { kind: "document", title: `Content part · ${target}`, body, format: "text" },
      }
    },
  },
]
