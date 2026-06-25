/**
 * Inline ghost-text autosuggest for the composer (fish-shell style).
 *
 * Given the current buffer, return the remaining suffix of the best-matching
 * prior entry so the composer can render it as dim ghost text after the cursor.
 * Pure: the {@link Input} component supplies the live sources and decides when to
 * render / accept. The suggestion is intentionally conservative — it only fires
 * for a single-line buffer whose cursor is at the end of the line, so it never
 * fights inline editing or the `/` `@` completion popups.
 *
 * Sources:
 *   - command history (most-recent-first) for ordinary text;
 *   - slash command names (each with a leading `/`) once the buffer starts `/`.
 */
export interface SuggestSources {
  /** Prior submitted lines, most-recent-first. */
  history: string[]
  /** Known slash command names, each including the leading `/`. */
  commands: string[]
}

/**
 * The ghost suffix to show after `buffer`, or `null` when nothing should be
 * suggested. Returns only the part the user hasn't typed yet (never the whole
 * entry), so the caller renders `buffer` + ghost.
 *
 * @param buffer The composer's current text.
 * @param cursorAtLineEnd Whether the cursor sits at the end of the (last) line.
 * @param sources History + slash command names.
 */
export function suggest(
  buffer: string,
  cursorAtLineEnd: boolean,
  sources: SuggestSources
): string | null {
  // Only a non-empty, single-line buffer with the cursor at its end qualifies:
  // multiline drafts and mid-line edits should never sprout ghost text.
  if (buffer === "" || !cursorAtLineEnd || buffer.includes("\n")) return null

  const pool = buffer.startsWith("/") ? sources.commands : sources.history
  for (const entry of pool) {
    if (entry.length > buffer.length && entry.startsWith(buffer)) {
      return entry.slice(buffer.length)
    }
  }
  return null
}
