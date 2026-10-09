/**
 * Ordering for the agents table (ADR-0220). Filtering by text and source is
 * `filterCharacters` (`lib/plugin/character-pack/editor-projection.ts`), the
 * same predicate the settings list used, so search behaves as it always did.
 */

import type { Character } from "@cognia/agent-config-types"
import type { AgentSummary } from "./agent-activity"

export type AgentSortKey = "recent" | "name" | "updated"

/**
 * `recent` puts the agents last used first, then never-used agents by their
 * last edit, so a fresh install still opens on a meaningful order.
 */
export function sortAgents(
  agents: readonly Character[],
  sort: AgentSortKey,
  summaries: ReadonlyMap<string, AgentSummary>,
  locale?: string
): Character[] {
  const byName = (a: Character, b: Character) =>
    a.name.localeCompare(b.name, locale, { sensitivity: "base" })
  const list = [...agents]
  switch (sort) {
    case "name":
      return list.sort(byName)
    case "updated":
      return list.sort((a, b) => b.updatedAt - a.updatedAt || byName(a, b))
    case "recent":
      return list.sort((a, b) => {
        const la = summaries.get(a.id)?.lastActiveAt
        const lb = summaries.get(b.id)?.lastActiveAt
        if (la !== undefined && lb !== undefined && la !== lb) return lb - la
        if (la !== undefined && lb === undefined) return -1
        if (la === undefined && lb !== undefined) return 1
        return b.updatedAt - a.updatedAt || byName(a, b)
      })
  }
}
