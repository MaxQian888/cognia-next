// Tiny pure helpers for "list of string keys" UI preferences — a
// most-recently-used list and a membership toggle. Shared by the composer's
// slash-command store and the workflow node-palette store so the dedupe /
// cap / toggle semantics live in exactly one place.

/**
 * Return `list` with `item` moved to the front, de-duplicated, capped at
 * `limit` (most-recent-first MRU). Input is never mutated.
 */
export function pushRecent(list: readonly string[], item: string, limit: number): string[] {
  return [item, ...list.filter((x) => x !== item)].slice(0, limit)
}

/**
 * Return `list` with `item` removed if present, or appended if absent (order of
 * the other entries preserved). Input is never mutated.
 */
export function toggleInList(list: readonly string[], item: string): string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item]
}
