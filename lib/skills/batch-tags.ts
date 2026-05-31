// Pure tag-set helpers for batch tag management in the Skills panel. Kept
// separate from the DB layer so the union/diff math is unit-testable without a
// Dexie round-trip.

/** Add `tag` to a tag list, trimming + de-duplicating (case-sensitive). */
export function unionTag(tags: string[] | undefined, tag: string): string[] {
  const clean = tag.trim()
  if (!clean) return tags ?? []
  const set = new Set(tags ?? [])
  set.add(clean)
  return Array.from(set)
}

/** Remove `tag` from a tag list. */
export function withoutTag(tags: string[] | undefined, tag: string): string[] {
  return (tags ?? []).filter((t) => t !== tag)
}

/** Sorted union of every tag present across the given skills. */
export function tagsAcrossSkills(skills: Array<{ tags?: string[] }>): string[] {
  const set = new Set<string>()
  for (const s of skills) {
    for (const t of s.tags ?? []) set.add(t)
  }
  return Array.from(set).sort()
}
