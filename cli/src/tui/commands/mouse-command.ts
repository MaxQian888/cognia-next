/**
 * `/mouse` — switch the fullscreen mouse interaction model.
 *
 *   /mouse                open the picker (reuses the select overlay)
 *   /mouse select         native click-drag text selection (wheel inert; PgUp/PgDn scroll)
 *   /mouse scroll         capture the wheel to scroll the transcript (Shift+drag selects)
 *
 * Pure handler: it returns a `mouse` effect the App persists (to config.json) and
 * live-applies — rewriting the terminal mouse-tracking / alternate-scroll escapes
 * in place. The picker re-dispatches `/mouse <mode>` through the generic select
 * overlay (mirrors `/layout`), so there is no bespoke overlay wiring. Only
 * meaningful in the fullscreen layout on a TTY; harmless otherwise.
 */
import { MOUSE_MODES, DEFAULT_MOUSE_MODE, type MouseMode } from "../../config/schema"
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

/** One-line description of each mode, shown as the picker hint. */
const MODE_HINTS: Record<MouseMode, string> = {
  select: "native click-drag text selection (wheel off; PgUp/PgDn scroll)",
  scroll: "wheel scrolls the transcript (Shift+drag to select text)",
}

function handle(ctx: CommandContext): CommandEffect {
  const args = ctx.args.trim().toLowerCase()
  const current = ctx.config.mouse ?? DEFAULT_MOUSE_MODE
  if (!args) {
    return {
      kind: "openOverlay",
      overlay: {
        kind: "select",
        title: "Mouse mode",
        items: MOUSE_MODES.map((m) => ({
          id: m,
          label: m,
          hint: m === current ? `current — ${MODE_HINTS[m]}` : MODE_HINTS[m],
        })),
        index: Math.max(0, MOUSE_MODES.indexOf(current)),
        onSelectCommand: "mouse",
      },
    }
  }
  if (!(MOUSE_MODES as readonly string[]).includes(args)) {
    return {
      kind: "notice",
      message: `Unknown mouse mode "${args}" — choose: ${MOUSE_MODES.join(", ")}`,
    }
  }
  return { kind: "mouse", mode: args as MouseMode }
}

export const mouseCommand: CommandDescriptor = {
  name: "mouse",
  description: "switch the fullscreen mouse model (select / scroll)",
  category: "config",
  argumentHint: "[select | scroll]",
  handler: handle,
}
