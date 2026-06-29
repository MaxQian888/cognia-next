/**
 * `/menu` — open the command center: a curated, clickable index of the most
 * common actions (mode/model/thinking pickers, settings, mcp, skills, agents,
 * usage, diff, context, theme, mouse, help). Each row runs its own slash command
 * when picked, so the panel is a fast launcher AND an at-a-glance status readout.
 *
 * Pure handler: it returns a `quickActions` overlay built from the live config
 * (so each row shows the current value). The panel itself owns the highlight and
 * routes a pick back through the normal command dispatcher. See
 * `runtime/build-quick-actions` and `components/overlays/QuickActionsPanel`.
 */
import { buildQuickActions } from "../runtime/build-quick-actions"
import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

function handle(ctx: CommandContext): CommandEffect {
  return {
    kind: "openOverlay",
    overlay: { kind: "quickActions", rows: buildQuickActions(ctx.config) },
  }
}

export const menuCommand: CommandDescriptor = {
  name: "menu",
  aliases: ["actions", "quick"],
  description: "open the command center (quick actions)",
  category: "system",
  handler: handle,
}
