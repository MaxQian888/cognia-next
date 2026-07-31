/**
 * `/layout` — switch the TUI layout model.
 *
 *   /layout                    open the picker (reuses the select overlay)
 *   /layout fullscreen         pin banner + composer, scroll the middle (alt-screen)
 *   /layout scrollback         historic native-scrollback `<Static>` model
 *
 * Pure handler: it returns a `layout` effect the App persists (to config.json)
 * and live-applies — entering / leaving the alternate screen buffer and swapping
 * the render tree. The picker re-dispatches `/layout <mode>` through the generic
 * select overlay (mirrors `/mascot` / `/statusbar`), so there is no bespoke
 * overlay wiring. The effective layout still degrades to scrollback on a non-TTY
 * terminal regardless of this preference (see `tui/layout-mode`).
 */
import { LAYOUT_MODES, type LayoutMode } from "../../config/schema"
import { DEFAULT_LAYOUT } from "../layout-mode"
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

/** One-line description of each mode, shown as the picker hint. */
const MODE_HINTS: Record<LayoutMode, string> = {
  fullscreen: "fixed banner + composer, scrollable middle (alt-screen)",
  scrollback: "native terminal scrollback (Static)",
}

function handle(ctx: CommandContext): CommandEffect {
  const args = ctx.args.trim().toLowerCase()
  const current = ctx.config.layout ?? DEFAULT_LAYOUT
  if (!args) {
    return {
      kind: "openOverlay",
      overlay: {
        kind: "select",
        title: "Layout",
        items: LAYOUT_MODES.map((m) => ({
          id: m,
          label: m,
          hint: m === current ? `current — ${MODE_HINTS[m]}` : MODE_HINTS[m],
        })),
        index: Math.max(0, LAYOUT_MODES.indexOf(current)),
        onSelectCommand: "layout",
      },
    }
  }
  if (!(LAYOUT_MODES as readonly string[]).includes(args)) {
    return {
      kind: "notice",
      message: `Unknown layout "${args}" — choose: ${LAYOUT_MODES.join(", ")}`,
    }
  }
  return { kind: "layout", mode: args as LayoutMode }
}

export const layoutCommand: CommandDescriptor = {
  name: "layout",
  description: "switch the TUI layout (fullscreen / scrollback)",
  category: "config",
  argumentHint: "[fullscreen | scrollback]",
  handler: handle,
}
