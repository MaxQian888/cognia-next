/**
 * Derive an inline usage hint for a partially-typed command line, shown as a dim
 * line under the composer once a space has been typed after a known command.
 *
 * Pure. Reuses the registry + dispatcher + `formatArgHint` so the hint strings
 * stay a single source of truth with `/help` and the form dispatcher.
 *
 * Gating: returns `null` until a whitespace follows the command name, so it never
 * competes with the `/` slash palette (which only shows for the no-space token).
 */
import { formatArgHint } from "./arg-hint"
import { parseCommandLine, resolveSubcommand } from "./dispatch"
import { getCommand } from "./registry"
import type { CommandDescriptor } from "./types"

/**
 * Build the inline hint for `line`, or `null` when there's nothing useful to add.
 *
 * - `/goal ` → `/goal <objective | status | pause | resume | stop | list>`
 * - `/memory add ` → `/memory add <text>`
 * - `/goal status` (a subcommand with no args) → `null`
 * - `/go` (no trailing space) → `null` (slash-palette territory)
 * - `/unknown ` → `null`
 */
export function buildCommandHint(line: string): string | null {
  // Only once a space has been typed after the command token.
  if (!/^\/\S+\s/.test(line)) return null

  const parsed = parseCommandLine(line)
  if (!parsed) return null

  const desc = getCommand(parsed.name)
  if (!desc) return null

  const firstToken = parsed.rest.split(/\s+/)[0] ?? ""
  const sub = firstToken ? resolveSubcommand(desc, firstToken) : undefined

  if (sub) {
    // Reuse `formatArgHint` by projecting the subcommand onto the descriptor
    // fields it reads (argumentHint / args).
    const subHint = formatArgHint({
      argumentHint: sub.argumentHint,
      args: sub.args,
    } as CommandDescriptor)
    if (!subHint) return null
    return `/${desc.name} ${sub.name} ${subHint}`
  }

  // No subcommand matched yet — show the root hint (subcommand list or args).
  const rootHint = formatArgHint(desc)
  if (!rootHint) return null
  return `/${desc.name} ${rootHint}`
}
