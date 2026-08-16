/**
 * Slash-command inline completion.
 *
 * Complements — rather than duplicates — the `/` palettes both surfaces
 * already have (`cli/src/tui/components/SlashPalette.tsx`,
 * `components/chat/composer-popover.tsx`). Those list every match and own the
 * arrow keys; this provider fills the gap where the palette is *not* on screen
 * but a completion is still wanted:
 *
 *   - the TUI, after the user dismissed the palette with Esc — previously the
 *     command pool in `autosuggest.ts` was the only thing left, and it stopped
 *     at the first registry hit with no ordering at all;
 *   - any surface that renders ghost text without a popup.
 *
 * Completions are necessarily PREFIX matches: a suggestion must extend the
 * draft verbatim (see `rank.ts`), so the fuzzy/subsequence matching the
 * palettes use cannot apply here — `gl` → `goal` is a *replacement*, and
 * belongs to the palette, not the ghost.
 */

import {
  DEFAULT_INLINE_MAX_CANDIDATES,
  type InlineCommandInfo,
  type InlineCompletionContext,
  type InlineCompletionProvider,
  type InlineSuggestion,
} from "./types"

/** Provider id for the built-in slash-command source. */
export const COMMAND_PROVIDER_ID = "builtin:command"

/** Score for a hit on the command's canonical name. */
const NAME_SCORE = 0.9
/** Score for a hit on one of its aliases — a real match, but less certain. */
const ALIAS_SCORE = 0.6
/** Multiplier for a hit that only matched after case folding. */
const CASE_INSENSITIVE_PENALTY = 0.7

export interface CommandMatchOptions {
  /** Maximum matches returned. Defaults to {@link DEFAULT_INLINE_MAX_CANDIDATES}. */
  limit?: number
}

/**
 * The bare command query in `draft`, or null when the draft is not a lone
 * slash token. Mirrors `slashQuery` in `cli/src/tui/commands/matcher.ts`: a
 * command completes only while it is the whole draft, so `/add-dir /usr` is an
 * argument (handled by the file completers), not a second command.
 */
export function commandQuery(draft: string): string | null {
  if (!draft.startsWith("/")) return null
  if (/\s/.test(draft)) return null
  return draft.slice(1)
}

/** Rank the commands that prefix-complete `draft`, best first. */
export function rankCommandMatches(
  draft: string,
  commands: readonly InlineCommandInfo[],
  options: CommandMatchOptions = {}
): InlineSuggestion[] {
  const query = commandQuery(draft)
  // An empty query would make every command a "match" and pick one at random
  // to show as ghost text — actively misleading. The palette covers bare `/`.
  if (query === null || query.length === 0) return []

  const limit = options.limit ?? DEFAULT_INLINE_MAX_CANDIDATES
  const lowerQuery = query.toLowerCase()

  interface Scored {
    suggestion: InlineSuggestion
    score: number
    length: number
    index: number
  }
  const scored: Scored[] = []

  commands.forEach((command, index) => {
    // Best hit across the canonical name and every alias: the name is worth
    // more, and an exact-case hit is worth more than a folded one.
    let best: { completion: string; score: number } | null = null

    const consider = (candidate: string, base: number): void => {
      if (candidate.length <= query.length) return
      const exactCase = candidate.startsWith(query)
      if (!exactCase && !candidate.toLowerCase().startsWith(lowerQuery)) return
      // Preserve exactly what the user typed; borrow only the tail. This keeps
      // the suggestion append-only even when the case differs.
      const completion = `/${query}${candidate.slice(query.length)}`
      const score = exactCase ? base : base * CASE_INSENSITIVE_PENALTY
      if (!best || score > best.score) best = { completion, score }
    }

    consider(command.name, NAME_SCORE)
    for (const alias of command.aliases ?? []) consider(alias, ALIAS_SCORE)

    if (!best) return
    const hit: { completion: string; score: number } = best
    scored.push({
      suggestion: {
        text: hit.completion,
        source: "command",
        providerId: COMMAND_PROVIDER_ID,
        detail: "command",
        description: command.description,
        score: hit.score,
      },
      score: hit.score,
      length: hit.completion.length,
      index,
    })
  })

  // Score first, then the shortest completion (the nearest command wins over a
  // longer one sharing its prefix: `/pr` before `/pr-comments`), then registry
  // order so the sequence is deterministic for cycling.
  scored.sort((a, b) => b.score - a.score || a.length - b.length || a.index - b.index)
  return scored.slice(0, limit).map((s) => s.suggestion)
}

/**
 * Build the built-in slash-command provider. Synchronous — the command list is
 * already in memory on both surfaces.
 */
export function createCommandProvider(options: CommandMatchOptions = {}): InlineCompletionProvider {
  return {
    id: COMMAND_PROVIDER_ID,
    label: "Commands",
    priority: 20,
    sync: true,
    async getCompletions(context: InlineCompletionContext): Promise<InlineSuggestion[]> {
      return rankCommandMatches(context.draft, context.commands, options)
    },
  }
}
