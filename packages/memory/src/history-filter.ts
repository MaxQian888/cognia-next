/**
 * Pure search / filter / sort for the `/memory` management panel. Mirrors the
 * `lib/goal/history-filter.ts` pattern — no React, runs inside a `useMemo`.
 */

import type { Memory, MemoryProvenance, MemoryScope, MemoryType } from "./types/memory"

export type MemorySortKey = "recent" | "importance" | "accessed" | "created"

export interface MemoryFilter {
  /** Case-insensitive substring over `text` + `tags` + `key`. */
  query?: string
  /** Allowed types; empty/undefined = all. */
  types?: MemoryType[]
  /** Allowed scopes; empty/undefined = all. */
  scopes?: MemoryScope[]
  /** Allowed provenances; empty/undefined = all. */
  provenances?: MemoryProvenance[]
  /** Memory must include EVERY listed tag (AND). Empty/undefined = no tag gate. */
  tags?: string[]
  /** `active` (default) shows only active; `all` includes invalidated. */
  status?: "active" | "all"
  sort?: MemorySortKey
}

function matchesQuery(m: Memory, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  if (m.text.toLowerCase().includes(needle)) return true
  if (m.key && m.key.toLowerCase().includes(needle)) return true
  return m.tags.some((t) => t.toLowerCase().includes(needle))
}

export function filterAndSortMemories(memories: Memory[], filter: MemoryFilter = {}): Memory[] {
  const query = (filter.query ?? "").trim()
  const status = filter.status ?? "active"
  const allowType = filter.types && filter.types.length > 0 ? new Set(filter.types) : null
  const allowScope = filter.scopes && filter.scopes.length > 0 ? new Set(filter.scopes) : null
  const allowProvenance =
    filter.provenances && filter.provenances.length > 0 ? new Set(filter.provenances) : null
  const requiredTags =
    filter.tags && filter.tags.length > 0 ? filter.tags.map((t) => t.toLowerCase()) : null
  const sort = filter.sort ?? "recent"

  const filtered = memories.filter((m) => {
    if (status === "active" && m.status !== "active") return false
    if (allowType && !allowType.has(m.type)) return false
    if (allowScope && !allowScope.has(m.scope)) return false
    if (allowProvenance && !allowProvenance.has(m.provenance)) return false
    if (requiredTags) {
      const lower = m.tags.map((t) => t.toLowerCase())
      if (!requiredTags.every((t) => lower.includes(t))) return false
    }
    return matchesQuery(m, query)
  })

  const sorted = filtered.slice()
  sorted.sort((a, b) => {
    // Pinned always float to the top regardless of sort key.
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    switch (sort) {
      case "importance":
        return b.importance - a.importance || b.updatedAt - a.updatedAt
      case "accessed":
        return b.lastAccessedAt - a.lastAccessedAt
      case "created":
        return b.createdAt - a.createdAt
      case "recent":
      default:
        return b.updatedAt - a.updatedAt
    }
  })
  return sorted
}

export interface MemoryStats {
  total: number
  active: number
  /** Active + pinned rows (exempt from decay). */
  pinned: number
  byType: Record<MemoryType, number>
}

export function computeMemoryStats(memories: Memory[]): MemoryStats {
  const byType: Record<MemoryType, number> = { semantic: 0, episodic: 0, procedural: 0 }
  let active = 0
  let pinned = 0
  for (const m of memories) {
    if (m.status === "active") {
      active++
      byType[m.type]++
      if (m.pinned) pinned++
    }
  }
  return { total: memories.length, active, pinned, byType }
}
