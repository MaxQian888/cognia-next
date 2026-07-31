/**
 * `/mascot` — the terminal mascot (the little creature above the footer).
 *
 *   /mascot                 open the style picker (reuses the select overlay)
 *   /mascot on | off        show / hide the mascot
 *   /mascot style <name>    pick a style (clawd | cat | robot) — also re-enables
 *
 * Pure handler: it returns a `mascot` effect the App persists (to config.json)
 * and live-applies via the reducer. The picker re-dispatches `/mascot style <id>`
 * through the generic select overlay — no bespoke wiring (mirrors `/statusbar`).
 */
import { MASCOT_STYLES, type MascotStyle } from "../../config/schema"
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

function handle(ctx: CommandContext): CommandEffect {
  const args = ctx.args.trim()
  if (!args) {
    return {
      kind: "openOverlay",
      overlay: {
        kind: "select",
        title: "Mascot style",
        items: MASCOT_STYLES.map((s) => ({
          id: s,
          label: s,
          hint: (ctx.config.mascot?.style ?? "clawd") === s ? "current" : undefined,
        })),
        index: 0,
        onSelectCommand: "mascot style",
      },
    }
  }

  const [verb, ...rest] = args.split(/\s+/)
  const value = rest.join(" ").trim()
  switch (verb.toLowerCase()) {
    case "on":
      return { kind: "mascot", patch: { enabled: true } }
    case "off":
      return { kind: "mascot", patch: { enabled: false } }
    case "style": {
      if (!(MASCOT_STYLES as readonly string[]).includes(value)) {
        return {
          kind: "notice",
          message: `Unknown mascot style "${value}" — choose: ${MASCOT_STYLES.join(", ")}`,
        }
      }
      // Picking a style implies wanting the mascot on.
      return { kind: "mascot", patch: { style: value as MascotStyle, enabled: true } }
    }
    default:
      return {
        kind: "notice",
        message: `Usage: /mascot [on | off | style <${MASCOT_STYLES.join(" | ")}>]`,
      }
  }
}

export const mascotCommand: CommandDescriptor = {
  name: "mascot",
  description: "toggle / style the terminal mascot",
  category: "config",
  argumentHint: "[on | off | style <name>]",
  handler: handle,
}
