/**
 * `/menu` — open the command center: a curated, clickable index of the most
 * common actions (mode/model/thinking pickers, settings, mcp, skills, agents,
 * usage, diff, context, theme, mouse, help). Each row runs its own slash command
 * when picked, so the panel is a fast launcher AND an at-a-glance status readout.
 *
 * Pure handler: it returns a `quickActions` overlay built from the live config
 * (so each curated row shows the current value) plus every visible registry
 * command. The overlay renders through the shared searchable `SelectList`
 * (reducer-owned cursor + typeahead). See `runtime/build-command-palette`.
 */
import { buildCommandPalette } from "../runtime/build-command-palette"
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

function handle(ctx: CommandContext): CommandEffect {
  return {
    kind: "openOverlay",
    overlay: { kind: "quickActions", rows: buildCommandPalette(ctx.config), index: 0 },
  }
}

export const menuCommand: CommandDescriptor = {
  name: "menu",
  aliases: ["actions", "quick"],
  description: "open the command center (searchable command palette)",
  category: "system",
  handler: handle,
}
