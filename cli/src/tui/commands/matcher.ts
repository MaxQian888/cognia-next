/**
 * Slash-command parsing + palette matching. Pure helpers over the registry.
 */
import { getCommand, listVisibleCommands, type SlashCommand } from "./registry"

export interface ParsedSlash {
  command: string
  args: string
}

/** Options for {@link matchSlash}. */
export interface MatchSlashOptions {
  /** Composer history (oldest → newest). Recently used root commands are
   * boosted to the top of the palette. */
  history?: string[]
}

/** Parse a `/command rest of line` into its parts, or null if not a slash line. */
export function parseSlash(line: string): ParsedSlash | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith("/")) return null
  const [word, ...rest] = trimmed.slice(1).split(/\s+/)
  return { command: word.toLowerCase(), args: rest.join(" ") }
}

/** Resolve a typed command name (or alias) to its registry entry. */
export function resolveCommand(name: string): SlashCommand | undefined {
  return getCommand(name)
}

/** Build a map from canonical command name to its most recent history index. */
function recentCommandIndex(history: string[]): Map<string, number> {
  const index = new Map<string, number>()
  for (let i = 0; i < history.length; i++) {
    const parsed = parseSlash(history[i])
    if (!parsed) continue
    const canonical = getCommand(parsed.command)?.name ?? parsed.command
    index.set(canonical, i)
  }
  return index
}

/** Filter the palette by a prefix typed after `/` (empty → all commands).
 * When `history` is supplied, recently used root commands sort first. */
export function matchSlash(query: string, opts: MatchSlashOptions = {}): SlashCommand[] {
  const all = listVisibleCommands()
  const q = query.toLowerCase()
  const matches =
    q.length === 0
      ? all
      : all.filter((c) => c.name.startsWith(q) || c.aliases?.some((a) => a.startsWith(q)))
  const recent = opts.history ? recentCommandIndex(opts.history) : new Map<string, number>()
  return matches.sort((a, b) => {
    const ia = recent.get(a.name)
    const ib = recent.get(b.name)
    if (ia !== undefined && ib !== undefined) return ib - ia
    if (ia !== undefined) return -1
    if (ib !== undefined) return 1
    return 0
  })
}

/**
 * Whether the current editor text is a bare slash query — `/` at the line start
 * with no space yet — meaning the palette should be shown. Returns the query
 * (text after `/`) or null.
 */
export function slashQuery(text: string): string | null {
  if (!text.startsWith("/")) return null
  if (/\s/.test(text)) return null
  return text.slice(1)
}
