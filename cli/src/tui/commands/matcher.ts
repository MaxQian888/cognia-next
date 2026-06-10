/**
 * Slash-command parsing + palette matching. Pure helpers over the registry.
 */
import { SLASH_COMMANDS, type SlashCommand } from "./registry"

export interface ParsedSlash {
  command: string
  args: string
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
  const lower = name.toLowerCase()
  return SLASH_COMMANDS.find((c) => c.name === lower || c.aliases?.includes(lower))
}

/** Filter the palette by a prefix typed after `/` (empty → all commands). */
export function matchSlash(query: string): SlashCommand[] {
  const q = query.toLowerCase()
  if (q.length === 0) return SLASH_COMMANDS
  return SLASH_COMMANDS.filter(
    (c) => c.name.startsWith(q) || c.aliases?.some((a) => a.startsWith(q))
  )
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
