/**
 * Pure selection-index math for the keyboard `SelectList` and any inline popup
 * (slash palette, file completer) that tracks its own highlighted row.
 */

/** Move a selection index by `delta`, wrapping at the list ends. */
export function moveIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0
  return (((current + delta) % length) + length) % length
}

/** Clamp an index into `[0, length)`. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(index, length - 1))
}

/**
 * Case-insensitive, whitespace-tokenised substring filter over arbitrary rows —
 * `toText` projects each row to its searchable haystack. Every token must appear
 * somewhere in that text (AND semantics), so `"claude opus"` narrows
 * progressively rather than requiring the exact phrase. A blank query returns the
 * list unchanged. Pure — backs every typeahead overlay (model catalog, generic
 * select/sessions/inspect lists, the command palette).
 */
export function filterRowsByQuery<T>(rows: T[], query: string, toText: (row: T) => string): T[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return rows
  return rows.filter((row) => {
    const hay = toText(row).toLowerCase()
    return tokens.every((t) => hay.includes(t))
  })
}

/**
 * String-list specialisation of {@link filterRowsByQuery} — backs the `/model`
 * picker's typeahead search so a long catalog (hundreds of OpenRouter ids) is
 * narrowed by typing.
 */
export function filterByQuery(items: string[], query: string): string[] {
  return filterRowsByQuery(items, query, (item) => item)
}
