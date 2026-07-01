/**
 * Pure builder for the `/menu` command center — a searchable, clickable index
 * that fronts every slash command. It leads with the curated quick actions (each
 * annotated with its live value, so the panel doubles as a status readout) and
 * then appends every other visible registry command, so a user can fuzzy-jump to
 * any command without remembering its exact name — the Claude-Code command
 * palette. Pure data transform: no Ink/IO, unit-tests without a render.
 */
import { buildQuickActions } from "./build-quick-actions"
import { listVisibleCommands } from "../commands/registry"
import type { ResolvedConfig } from "../../config/schema"
import type { QuickActionRow } from "../state/types"

/**
 * Curated quick actions first (with live hints), then every other visible
 * registry command as a row. A command is skipped when a curated row already
 * runs it (matched by the `/name` the row dispatches), so the common pickers
 * aren't duplicated. `command` is always `/<name>`; the hint is the command's
 * one-line description.
 */
export function buildCommandPalette(config: ResolvedConfig): QuickActionRow[] {
  const curated = buildQuickActions(config)
  // The bare command each curated row runs (`/model effort` → `model`), so a
  // registry command already fronted by a curated row is not listed twice.
  const curatedCommands = new Set(
    curated.map((r) => r.command.replace(/^\//, "").split(/\s+/)[0]?.toLowerCase()).filter(Boolean)
  )
  const rest: QuickActionRow[] = listVisibleCommands()
    .filter((c) => !curatedCommands.has(c.name.toLowerCase()))
    .map((c) => ({
      id: `cmd:${c.name}`,
      label: `/${c.name}`,
      hint: c.description,
      command: `/${c.name}`,
    }))
  return [...curated, ...rest]
}
