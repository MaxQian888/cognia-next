"use client"

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { inferCategory, inferSource, listSkills } from "@/lib/db/skills"
import type { Skill } from "@/lib/claude/types"
import { useSkillsStore, type SkillFilters } from "@/stores/skills-store"

export interface SkillsView {
  /** Raw rows from Dexie (unfiltered, unsorted). */
  all: Skill[]
  /** After applying current filters and sort. */
  filtered: Skill[]
  /** Aggregated counts by source (used by the category sidebar badges). */
  countsBySource: Record<string, number>
  /** Aggregated counts by category. */
  countsByCategory: Record<string, number>
  /** All distinct tags across the skills list. */
  allTags: string[]
  loading: boolean
}

export function useSkills(): SkillsView {
  const rows = useLiveQuery(() => listSkills(), [])
  const filters = useSkillsStore((s) => s.filters)
  return useMemo(() => buildView(rows ?? null, filters), [rows, filters])
}

function buildView(rows: Skill[] | null, filters: SkillFilters): SkillsView {
  const all = rows ?? []
  const countsBySource: Record<string, number> = {}
  const countsByCategory: Record<string, number> = {}
  const tagSet = new Set<string>()
  for (const r of all) {
    const src = inferSource(r)
    const cat = inferCategory(r)
    countsBySource[src] = (countsBySource[src] ?? 0) + 1
    countsByCategory[cat] = (countsByCategory[cat] ?? 0) + 1
    for (const tag of r.tags ?? []) tagSet.add(tag)
  }

  const filtered = applyFilters(all, filters).sort(sortFor(filters.sort))

  return {
    all,
    filtered,
    countsBySource,
    countsByCategory,
    allTags: Array.from(tagSet).sort(),
    loading: rows === undefined,
  }
}

function applyFilters(rows: Skill[], filters: SkillFilters): Skill[] {
  const q = filters.query.trim().toLowerCase()
  return rows.filter((row) => {
    if (filters.category !== "all" && inferCategory(row) !== filters.category) return false
    if (filters.source !== "all" && inferSource(row) !== filters.source) return false
    const status = row.status ?? "enabled"
    if (filters.status !== "all" && status !== filters.status) return false
    if (filters.tag && !(row.tags ?? []).includes(filters.tag)) return false
    if (q) {
      if (
        !row.name.toLowerCase().includes(q) &&
        !(row.description ?? "").toLowerCase().includes(q) &&
        !(row.tags ?? []).some((t) => t.toLowerCase().includes(q)) &&
        !(row.content ?? "").toLowerCase().includes(q)
      ) {
        return false
      }
    }
    return true
  })
}

function sortFor(mode: SkillFilters["sort"]) {
  return (a: Skill, b: Skill): number => {
    if (mode === "updated") return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
    if (mode === "usage") return (b.usageCount ?? 0) - (a.usageCount ?? 0)
    return a.name.localeCompare(b.name)
  }
}
