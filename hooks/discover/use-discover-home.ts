"use client"

/**
 * Aggregated data for the "For You" landing (`foryou` pseudo-category).
 *
 * Reuses `useDiscoverQuery` once per home-featured category (no new data layer
 * — the plan's core reuse principle) and composes the results into sections
 * plus a featured strip and a recent strip. When the search box is non-empty
 * it flattens every category's already-filtered matches into one cross-category
 * result list — this is the discover page's global search.
 *
 * The flat `items` list (deduped) is the single source the inspector reads when
 * an item is selected on the landing page.
 */

import { useMemo } from "react"

import type { DiscoverGroup, DiscoverCategoryId } from "@/lib/discover/categories"
import { getCategory } from "@/lib/discover/categories"
import { useDiscoverQuery, type DiscoverItem } from "@/hooks/discover/use-discover-query"

/** Max items shown per quick-browse row. */
const SECTION_LIMIT = 8
/** Max items in the featured strip / recent strip. */
const STRIP_LIMIT = 12

export interface DiscoverHomeSection {
  category: DiscoverCategoryId
  group: DiscoverGroup
  items: DiscoverItem[]
  /** Total matches in the category (before the row is truncated to SECTION_LIMIT). */
  total: number
}

export interface DiscoverHomeResult {
  /** Curated highlights (built-in personas/skills/teams + templates). */
  featured: DiscoverItem[]
  /** Most-recently-updated user content across kinds. */
  recent: DiscoverItem[]
  /** Per-category quick-browse rows (non-empty only). */
  sections: DiscoverHomeSection[]
  /** Flat, deduped union of everything surfaced — feeds the inspector. */
  items: DiscoverItem[]
  /** Cross-category matches when searching (query non-empty). */
  searchResults: DiscoverItem[]
  /** True when the search box drives a global cross-category result list. */
  searching: boolean
  /** True while any Dexie-backed source's first read is in flight. */
  loading: boolean
}

/** Loosely read an updated/created timestamp; registry items have none (→ 0). */
function itemTimestamp(item: DiscoverItem): number {
  const d = item.data as { updatedAt?: number; createdAt?: number; importedAt?: number }
  return d.updatedAt ?? d.createdAt ?? d.importedAt ?? 0
}

/** Curated "featured" predicate — built-in personas/skills/teams/templates. */
function isFeatured(item: DiscoverItem): boolean {
  switch (item.kind) {
    case "character":
    case "team":
    case "skill":
    case "teamTemplate":
      return Boolean((item.data as { isBuiltIn?: boolean }).isBuiltIn)
    case "workflowTemplate":
      return true
    default:
      return false
  }
}

export function useDiscoverHome(query: string): DiscoverHomeResult {
  const trimmed = query.trim()
  const searching = trimmed.length > 0

  // One subscription per home-featured category. Called with stable literals so
  // React hook order never changes. Each already applies the query filter.
  const characters = useDiscoverQuery("characters", query)
  const teams = useDiscoverQuery("teams", query)
  const skills = useDiscoverQuery("skills", query)
  const teamTemplates = useDiscoverQuery("teamTemplates", query)
  const agentPresets = useDiscoverQuery("agentPresets", query)
  const plugins = useDiscoverQuery("plugins", query)
  const mcpPresets = useDiscoverQuery("mcpPresets", query)
  const slashCommands = useDiscoverQuery("slashCommands", query)
  const workflowTemplates = useDiscoverQuery("workflowTemplates", query)

  return useMemo<DiscoverHomeResult>(() => {
    const perCategory: Array<{ id: DiscoverCategoryId; items: DiscoverItem[] }> = [
      { id: "characters", items: characters.items },
      { id: "teams", items: teams.items },
      { id: "skills", items: skills.items },
      { id: "teamTemplates", items: teamTemplates.items },
      { id: "agentPresets", items: agentPresets.items },
      { id: "plugins", items: plugins.items },
      { id: "mcpPresets", items: mcpPresets.items },
      { id: "slashCommands", items: slashCommands.items },
      { id: "workflowTemplates", items: workflowTemplates.items },
    ]

    // Flat, deduped union (a plugin/preset could appear under favorites too).
    const seen = new Set<string>()
    const flat: DiscoverItem[] = []
    for (const { items } of perCategory) {
      for (const item of items) {
        const key = `${item.kind}:${item.id}`
        if (seen.has(key)) continue
        seen.add(key)
        flat.push(item)
      }
    }

    const sections: DiscoverHomeSection[] = perCategory
      .filter(({ items }) => items.length > 0)
      .map(({ id, items }) => ({
        category: id,
        group: getCategory(id)?.group ?? "agents",
        items: items.slice(0, SECTION_LIMIT),
        total: items.length,
      }))

    const featured = flat.filter(isFeatured).slice(0, STRIP_LIMIT)

    const recent = [...flat]
      .filter((i) => itemTimestamp(i) > 0)
      .sort((a, b) => itemTimestamp(b) - itemTimestamp(a))
      .slice(0, STRIP_LIMIT)

    const loading =
      characters.loading ||
      teams.loading ||
      skills.loading ||
      plugins.loading ||
      agentPresets.loading

    return {
      featured,
      recent,
      sections,
      items: flat,
      searchResults: searching ? flat : [],
      searching,
      loading,
    }
  }, [
    characters.items,
    teams.items,
    skills.items,
    teamTemplates.items,
    agentPresets.items,
    plugins.items,
    mcpPresets.items,
    slashCommands.items,
    workflowTemplates.items,
    characters.loading,
    teams.loading,
    skills.loading,
    plugins.loading,
    agentPresets.loading,
    searching,
  ])
}
