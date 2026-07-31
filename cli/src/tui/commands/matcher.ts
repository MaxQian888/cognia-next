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

/** Whether every char of `q` appears in `s` in order (a loose fuzzy match). */
function isSubsequence(q: string, s: string): boolean {
  let i = 0
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) i++
  }
  return i === q.length
}

/**
 * Filter the palette by what's typed after `/` (empty → all commands). Matching
 * is tiered so the common case is unchanged and discovery improves only when a
 * prefix finds nothing:
 *   1. name/alias PREFIX (the historic behaviour — exact same results)
 *   2. fuzzy SUBSEQUENCE over name/alias (so `gl` finds `goal`)
 *   3. DESCRIPTION keyword (so `theme` finds commands that mention it)
 * When `history` is supplied, recently used root commands sort first within the
 * chosen tier.
 */
export function matchSlash(query: string, opts: MatchSlashOptions = {}): SlashCommand[] {
  const all = listVisibleCommands()
  const q = query.toLowerCase()
  let matches: SlashCommand[]
  if (q.length === 0) {
    matches = all
  } else {
    const prefix = all.filter(
      (c) => c.name.startsWith(q) || c.aliases?.some((a) => a.startsWith(q))
    )
    if (prefix.length > 0) {
      matches = prefix
    } else {
      const fuzzy = all.filter(
        (c) => isSubsequence(q, c.name) || c.aliases?.some((a) => isSubsequence(q, a))
      )
      matches =
        fuzzy.length > 0 ? fuzzy : all.filter((c) => c.description.toLowerCase().includes(q))
    }
  }
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
