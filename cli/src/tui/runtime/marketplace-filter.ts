/**
 * Pure search + section filtering for the interactive plugin-marketplace overlay.
 * Sections are data-driven over the catalog fields the GitHub marketplace
 * actually carries (downloads / rating / signature) — no fabricated "featured"
 * or "recent" buckets the source can't back. No React, no Dexie.
 */

/** A browse-grid row carrying its install ref + the catalog metadata. */
export interface MarketplaceBrowseEntry {
  installRef: string
  name: string
  description?: string
  author?: string
  version?: string
  rating?: number
  downloads?: number
  signed?: boolean
}

export type MarketplaceSection = "all" | "popular" | "top-rated" | "signed"

/** The section tabs, in cycle order. */
export const MARKETPLACE_SECTIONS: MarketplaceSection[] = ["all", "popular", "top-rated", "signed"]

function matchesQuery(e: MarketplaceBrowseEntry, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return [e.name, e.description, e.author, e.installRef].some(
    (f) => typeof f === "string" && f.toLowerCase().includes(needle)
  )
}

/**
 * Apply the free-text `query` then the `section` lens:
 *   - all       → query order preserved
 *   - popular   → sorted by downloads desc
 *   - top-rated → only entries with a rating, sorted by rating desc
 *   - signed    → only signed entries
 */
export function filterMarketplace(
  entries: MarketplaceBrowseEntry[],
  query: string,
  section: MarketplaceSection
): MarketplaceBrowseEntry[] {
  const matched = entries.filter((e) => matchesQuery(e, query))
  switch (section) {
    case "popular":
      return [...matched].sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))
    case "top-rated":
      return matched
        .filter((e) => typeof e.rating === "number")
        .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    case "signed":
      return matched.filter((e) => e.signed === true)
    default:
      return matched
  }
}

/** Next section in the cycle (Tab). */
export function nextSection(section: MarketplaceSection): MarketplaceSection {
  const i = MARKETPLACE_SECTIONS.indexOf(section)
  return MARKETPLACE_SECTIONS[(i + 1) % MARKETPLACE_SECTIONS.length]
}

/** One-line hint for a browse row: rating · downloads · author. */
export function entryHint(e: MarketplaceBrowseEntry): string {
  const parts: string[] = []
  if (typeof e.rating === "number") parts.push(`★ ${e.rating.toFixed(1)}`)
  if (typeof e.downloads === "number") parts.push(`⤓ ${e.downloads}`)
  if (e.signed) parts.push("signed")
  if (e.author) parts.push(`by ${e.author}`)
  if (parts.length === 0) return e.description ?? e.installRef
  return parts.join(" · ")
}
