/**
 * `/theme` — the TUI colour theme.
 *
 *   /theme                  open the theme picker (reuses the select overlay)
 *   /theme <name>           set a theme (built-in | claude-code | codex | custom:<slug>)
 *   /theme set <name>       same, explicit verb
 *
 * Pure handler: returns a `theme` effect the App persists (scalar config key)
 * and live-applies via the reducer, which re-resolves the palette. The picker
 * re-dispatches `/theme set <id>` through the generic select overlay — no
 * bespoke wiring (mirrors `/mascot` and `/statusbar`).
 */
import { THEME_CHOICES } from "../theme/resolve"
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

function isValid(value: string): boolean {
  return THEME_CHOICES.includes(value) || value.startsWith("custom:")
}

function handle(ctx: CommandContext): CommandEffect {
  const args = ctx.args.trim()
  if (!args) {
    const current = ctx.config.theme ?? "classic"
    return {
      kind: "openOverlay",
      overlay: {
        kind: "select",
        title: "Colour theme",
        items: THEME_CHOICES.map((name) => ({
          id: name,
          label: name,
          hint: name === current ? "current" : undefined,
        })),
        index: 0,
        onSelectCommand: "theme set",
      },
    }
  }

  const [verb, ...rest] = args.split(/\s+/)
  const value = (verb.toLowerCase() === "set" ? rest.join(" ") : args).trim()
  if (!isValid(value)) {
    return {
      kind: "notice",
      message: `Unknown theme "${value}" — choose: ${THEME_CHOICES.join(", ")}, or custom:<slug>`,
    }
  }
  return { kind: "theme", theme: value }
}

export const themeCommand: CommandDescriptor = {
  name: "theme",
  description: "switch the TUI colour theme (reuse Claude Code / Codex themes)",
  category: "config",
  argumentHint: "[<name> | set <name>]",
  handler: handle,
}
