/**
 * `/statusbar` — customize the footer's segments + color theme.
 *
 *   /statusbar                     open the theme picker (reuses the select overlay)
 *   /statusbar theme <name>        set the color theme (default|dim|vivid|mono)
 *   /statusbar segments a,b,c      set which segments show, in order
 *   /statusbar reset               restore the default layout + theme
 *
 * Pure handler: it returns a `statusBar` effect the App persists (to config.json)
 * and live-applies via the reducer. The theme picker re-dispatches
 * `/statusbar theme <id>` through the generic select overlay — no bespoke wiring.
 */
import {
  DEFAULT_STATUS_SEGMENTS,
  STATUS_SEGMENTS,
  STATUS_THEMES,
  type StatusSegment,
  type StatusTheme,
} from "../../config/schema"
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

function handle(ctx: CommandContext): CommandEffect {
  const args = ctx.args.trim()
  if (!args) {
    return {
      kind: "openOverlay",
      overlay: {
        kind: "select",
        title: "Status-bar theme",
        items: STATUS_THEMES.map((t) => ({
          id: t,
          label: t,
          hint: ctx.config.statusBar?.theme === t ? "current" : undefined,
        })),
        index: 0,
        onSelectCommand: "statusbar theme",
      },
    }
  }

  const [verb, ...rest] = args.split(/\s+/)
  const value = rest.join(" ").trim()
  switch (verb.toLowerCase()) {
    case "theme": {
      if (!(STATUS_THEMES as readonly string[]).includes(value)) {
        return {
          kind: "notice",
          message: `Unknown theme "${value}" — choose: ${STATUS_THEMES.join(", ")}`,
        }
      }
      return { kind: "statusBar", patch: { theme: value as StatusTheme } }
    }
    case "segments": {
      const ids = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      const invalid = ids.filter((id) => !(STATUS_SEGMENTS as readonly string[]).includes(id))
      if (ids.length === 0 || invalid.length > 0) {
        return {
          kind: "notice",
          message: `Segments: ${STATUS_SEGMENTS.join(", ")}. Use: /statusbar segments model,mode,ctx,cost`,
        }
      }
      return { kind: "statusBar", patch: { segments: ids as StatusSegment[] } }
    }
    case "reset":
      return {
        kind: "statusBar",
        patch: { segments: [...DEFAULT_STATUS_SEGMENTS], theme: "default" },
      }
    default:
      return {
        kind: "notice",
        message: "Usage: /statusbar [theme <name> | segments <a,b,c> | reset]",
      }
  }
}

export const statusbarCommand: CommandDescriptor = {
  name: "statusbar",
  description: "customize the status bar (segments + theme)",
  category: "config",
  argumentHint: "[theme <name> | segments <a,b,c>]",
  handler: handle,
}
