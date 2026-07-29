// GitHub "marketplace repo" catalog — mimics Claude Code's plugin dispatch:
// a repo ships a `marketplace.json` listing plugins, each pointing at a
// repo-relative directory that holds a cognia `plugin.json`. We fetch + parse
// the catalog into browse-grid entries; install of any entry routes through
// the GitHub source adapter (`makeGithubMarketplaceClient`) using the entry's
// `{ owner, repo, ref, subdir }` origin.

import type { PluginMarketplaceEntry } from "@/hooks/plugins/use-plugin-marketplace"
import {
  parseGithubPluginRef,
  fetchGithubFile,
  githubRepoUrl,
  type GithubPluginRef,
} from "./github-source"

/** Where a marketplace catalog may live, in priority order. */
const CATALOG_PATHS = [
  "marketplace.json",
  ".cognia/marketplace.json",
  ".claude-plugin/marketplace.json",
]

/** One plugin listed in a `marketplace.json` catalog. */
interface CatalogPlugin {
  name: string
  /** Repo-relative directory holding this plugin's `plugin.json`. */
  source: string
  /** Optional cognia plugin id (falls back to a synthetic key when absent). */
  id?: string
  description?: string
  version?: string
  author?: string
}

interface CatalogFile {
  name?: string
  owner?: { name?: string } | string
  plugins?: CatalogPlugin[]
}

/** A browse-grid entry that carries its GitHub origin for install routing. */
export interface GithubMarketplaceEntry extends PluginMarketplaceEntry {
  github: GithubPluginRef
}

export interface MarketplaceCatalog {
  /** Canonical `owner/repo[@ref]` the catalog was read from. */
  id: string
  /** Display name from the catalog, or the repo reference as a fallback. */
  name: string
  /** Catalog `owner` (string or `{ name }` form), when the file declares one. */
  owner?: string
  /** Which of the `CATALOG_PATHS` candidates actually matched. */
  catalogPath: string
  /** Browser URL for the repo — what "Open on GitHub" opens. */
  repoUrl: string
  entries: GithubMarketplaceEntry[]
}

function normalizeSubdir(source: string): string | undefined {
  const trimmed = source
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
  return trimmed || undefined
}

/**
 * Fetch + parse a marketplace repo's catalog into browse-grid entries.
 * Throws when no catalog is found or it has no valid `plugins` array.
 */
export async function fetchMarketplaceCatalog(repoRef: string): Promise<MarketplaceCatalog> {
  const ref = parseGithubPluginRef(repoRef)

  let raw: string | null = null
  let catalogPath = CATALOG_PATHS[0]
  for (const path of CATALOG_PATHS) {
    raw = await fetchGithubFile(ref, path)
    if (raw !== null) {
      catalogPath = path
      break
    }
  }
  if (raw === null) {
    throw new Error("no marketplace.json found in this repository")
  }

  let catalog: CatalogFile
  try {
    catalog = JSON.parse(raw) as CatalogFile
  } catch {
    throw new Error("marketplace.json is not valid JSON")
  }
  if (!Array.isArray(catalog.plugins)) {
    throw new Error("marketplace.json is missing a `plugins` array")
  }

  const ownerName = typeof catalog.owner === "string" ? catalog.owner : catalog.owner?.name
  const repoLabel = `${ref.owner}/${ref.repo}`

  const entries: GithubMarketplaceEntry[] = catalog.plugins
    .filter(
      (p): p is CatalogPlugin => !!p && typeof p.name === "string" && typeof p.source === "string"
    )
    .map((p) => {
      const subdir = normalizeSubdir(p.source)
      return {
        id: p.id ?? `${repoLabel}:${p.name}`,
        name: p.name,
        version: p.version ?? "",
        description: p.description,
        author: p.author ?? ownerName,
        type: "plugin",
        source: "git",
        github: { owner: ref.owner, repo: ref.repo, ref: ref.ref, subdir },
      }
    })

  return {
    id: `${repoLabel}${ref.ref ? `@${ref.ref}` : ""}`,
    name: catalog.name?.trim() || repoLabel,
    owner: ownerName?.trim() || undefined,
    catalogPath,
    repoUrl: githubRepoUrl({ owner: ref.owner, repo: ref.repo, ref: ref.ref }),
    entries,
  }
}

/** Per-source outcome of a catalog fetch. */
export type SourceFetchResult =
  | { repoRef: string; ok: true; catalog: MarketplaceCatalog }
  | { repoRef: string; ok: false; message: string }

/**
 * Fetch every saved source's catalog, returning the merged entry list.
 * Per-source failures are swallowed (a removed / renamed repo shouldn't blank
 * the whole grid) and reported via the returned `errors` list.
 *
 * `results` keeps the outcome attributed to its source, which is what lets a
 * caller record per-source health — `errors` alone can say a fetch failed but
 * not that the other three succeeded, and a source that stops failing has to
 * be able to clear its own error.
 */
export async function fetchAllSourceEntries(repoRefs: string[]): Promise<{
  entries: GithubMarketplaceEntry[]
  errors: Array<{ repoRef: string; message: string }>
  results: SourceFetchResult[]
}> {
  const results = await Promise.all(
    repoRefs.map(async (repoRef): Promise<SourceFetchResult> => {
      try {
        return { repoRef, ok: true, catalog: await fetchMarketplaceCatalog(repoRef) }
      } catch (err) {
        return { repoRef, ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    })
  )
  const entries = results.flatMap((r) => (r.ok ? r.catalog.entries : []))
  const errors = results
    .filter((r): r is Extract<SourceFetchResult, { ok: false }> => !r.ok)
    .map((r) => ({ repoRef: r.repoRef, message: r.message }))
  return { entries, errors, results }
}
