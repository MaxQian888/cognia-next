// View-model types for the marketplace **source** surfaces (add / list /
// recommend). Deliberately independent of Dexie rows and of
// `GithubMarketplaceEntry`: the presentational components below must be
// drivable from Storybook and from tests without opening IndexedDB or
// touching the GitHub API, and the dialog's most interesting states (a
// half-fetched preview, a source whose last sync failed) have no Dexie row
// that can express them.

/** One plugin listed in a previewed catalog. */
export interface SourcePreviewEntry {
  /** Catalog entry id — unique within the preview, used as the React key. */
  id: string
  name: string
  /** Catalog `version`, or "" when the catalog omits it. */
  version: string
  description?: string
}

/** Everything the user sees *before* committing to adding a source. */
export interface MarketplaceSourcePreview {
  /** Canonical `owner/repo[@ref]` — the id the source is stored under. */
  id: string
  /** Catalog `name`, falling back to `owner/repo`. */
  name: string
  /** Catalog `owner`, when the file declares one. */
  owner?: string
  /** Which of the three candidate catalog paths actually matched. */
  catalogPath: string
  /** Browser URL for the repo (+ `/tree/<ref>` when pinned). */
  repoUrl: string
  entries: SourcePreviewEntry[]
  /** True when this id is already in the saved list — add becomes a no-op. */
  alreadyAdded: boolean
}

/**
 * Per-source sync health. `never` is a real state, not a placeholder: a source
 * added while offline has a row but has never produced a catalog, and showing
 * it as "0 plugins" would be a lie.
 */
export type SourceSyncState =
  | { kind: "never" }
  | { kind: "syncing" }
  | { kind: "ok"; pluginCount: number; lastSyncedAt: number }
  | { kind: "error"; message: string; lastSyncedAt?: number }

/** A saved source as the list renders it. */
export interface MarketplaceSourceItem {
  id: string
  name: string
  /** The raw reference the user entered, shown verbatim in mono. */
  repoRef: string
  repoUrl: string
  sync: SourceSyncState
}

// The curated list itself lives in lib (it is data, not view state); re-exported
// here so the source components have one type surface to import from.
export type { RecommendedMarketplaceSource } from "@/lib/plugin/package/recommended-marketplace-sources"
