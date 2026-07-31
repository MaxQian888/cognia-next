/**
 * `/select` — switch the in-app drag-to-select model.
 *
 *   /select               open the picker (reuses the select overlay)
 *   /select off           no in-app selection (the historic input path)
 *   /select manual        drag paints a highlight; the copy chord takes it
 *   /select auto-copy     the drag copies itself the moment it ends
 *
 * Pure handler: it returns a `selection` effect the App persists (to config.json)
 * and live-applies — re-issuing the mouse escapes so button-event tracking turns
 * on/off with the feature. The picker re-dispatches `/select <mode>` through the
 * generic select overlay (mirrors `/mouse` and `/layout`), so there is no bespoke
 * overlay wiring. Only meaningful in the fullscreen layout with the `scroll`
 * mouse model; harmless otherwise (the notice says so).
 */
import {
  DEFAULT_MOUSE_MODE,
  DEFAULT_SELECTION_MODE,
  SELECTION_MODES,
  type SelectionMode,
} from "../../config/schema"
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

/** One-line description of each mode, shown as the picker hint. */
const MODE_HINTS: Record<SelectionMode, string> = {
  off: "no in-app selection (terminal defaults)",
  manual: "drag to highlight; copy with the copy-selection chord",
  "auto-copy": "drag to highlight and copy on release (划词自动复制)",
}

function handle(ctx: CommandContext): CommandEffect {
  const args = ctx.args.trim().toLowerCase()
  const current = ctx.config.selection ?? DEFAULT_SELECTION_MODE
  if (!args) {
    return {
      kind: "openOverlay",
      overlay: {
        kind: "select",
        title: "Text selection",
        items: SELECTION_MODES.map((m) => ({
          id: m,
          label: m,
          hint: m === current ? `current — ${MODE_HINTS[m]}` : MODE_HINTS[m],
        })),
        index: Math.max(0, SELECTION_MODES.indexOf(current)),
        onSelectCommand: "select",
      },
    }
  }
  if (!(SELECTION_MODES as readonly string[]).includes(args)) {
    return {
      kind: "notice",
      message: `Unknown selection mode "${args}" — choose: ${SELECTION_MODES.join(", ")}`,
    }
  }
  const mode = args as SelectionMode
  // Selection rides on SGR mouse tracking, which only the `scroll` model turns
  // on. Enabling it under `select` would silently do nothing, so say so rather
  // than leaving the user to wonder why dragging does not highlight.
  if (mode !== "off" && (ctx.config.mouse ?? DEFAULT_MOUSE_MODE) !== "scroll") {
    return {
      kind: "notice",
      message:
        "In-app selection needs the `scroll` mouse model (it reads the mouse). Run /mouse scroll first.",
    }
  }
  return { kind: "selection", mode }
}

export const selectCommand: CommandDescriptor = {
  name: "select",
  description: "in-app drag-to-select: off / manual / auto-copy on release",
  category: "config",
  argumentHint: "[off | manual | auto-copy]",
  handler: handle,
}
