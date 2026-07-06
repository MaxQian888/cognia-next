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
  /** This plugin is already installed locally (matched by origin install ref). */
  installed?: boolean
  /** When installed: whether it is currently enabled (vs disabled by the user). */
  enabled?: boolean
  /** When installed: the catalog version is newer than the installed one. */
  updatable?: boolean
  /** When installed: the local plugin id (so in-place actions can target it). */
  installedId?: string
}

export type MarketplaceSection = "all" | "popular" | "top-rated" | "signed"

/** An in-place action the marketplace browser can request on an entry. */
export type MarketplaceAction = "install" | "show" | "enable" | "disable" | "update" | "uninstall"

/** A locally-installed plugin's provenance, projected for install-state matching. */
export interface InstalledOrigin {
  /** The local plugin id. */
  id: string
  /** The GitHub ref it was installed from (`owner/repo[@ref][/subdir]`). */
  repoRef: string
  /** Installed manifest version. */
  version: string
  /** Whether it is currently enabled (vs disabled by the user). */
  enabled: boolean
}

/** Drop the `@ref` pin so `owner/repo@main/sub` and `owner/repo/sub` match. */
function normalizeRef(ref: string): string {
  return ref.replace(/@[^/]+/, "").toLowerCase()
}

/**
 * Loosely-semver "is `a` newer than `b`": numeric, dot-segmented, left-to-right.
 * Non-numeric / missing segments count as 0. Conservative — returns false when
 * equal or unparseable, so it never fabricates a spurious update prompt.
 */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split(".").map((s) => parseInt(s, 10) || 0)
  const pb = b.split(".").map((s) => parseInt(s, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/**
 * Annotate each catalog entry with its local install state by matching the
 * entry's `installRef` against the installed origins (ignoring the `@ref` pin).
 * `updatable` is set when the catalog version is strictly newer than the
 * installed one. Pure — the controller supplies `installed` from the origin +
 * disabled stores.
 */
export function annotateInstallState(
  entries: MarketplaceBrowseEntry[],
  installed: InstalledOrigin[]
): MarketplaceBrowseEntry[] {
  const byRef = new Map(installed.map((o) => [normalizeRef(o.repoRef), o]))
  return entries.map((e) => {
    const origin = byRef.get(normalizeRef(e.installRef))
    if (!origin)
      return {
        ...e,
        installed: false,
        enabled: undefined,
        updatable: undefined,
        installedId: undefined,
      }
    return {
      ...e,
      installed: true,
      enabled: origin.enabled,
      updatable: typeof e.version === "string" ? isNewerVersion(e.version, origin.version) : false,
      installedId: origin.id,
    }
  })
}

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

/**
 * Install-state badge for a browse row, or `""` when the entry is not installed.
 * Leads the hint so the status reads first: `↑ update` (installed but a newer
 * version is in the catalog), `✓ installed`, or `○ disabled`.
 */
export function entryStatusBadge(e: MarketplaceBrowseEntry): string {
  if (!e.installed) return ""
  if (e.updatable) return "↑ update"
  if (e.enabled === false) return "○ disabled"
  return "✓ installed"
}

/** One-line hint for a browse row: install-state · rating · downloads · author. */
export function entryHint(e: MarketplaceBrowseEntry): string {
  const parts: string[] = []
  const badge = entryStatusBadge(e)
  if (badge) parts.push(badge)
  if (typeof e.rating === "number") parts.push(`★ ${e.rating.toFixed(1)}`)
  if (typeof e.downloads === "number") parts.push(`⤓ ${e.downloads}`)
  if (e.signed) parts.push("signed")
  if (e.author) parts.push(`by ${e.author}`)
  if (parts.length === 0) return e.description ?? e.installRef
  return parts.join(" · ")
}
