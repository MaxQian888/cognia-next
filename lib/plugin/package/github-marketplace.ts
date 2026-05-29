// GitHub "marketplace repo" catalog — mimics Claude Code's plugin dispatch:
// a repo ships a `marketplace.json` listing plugins, each pointing at a
// repo-relative directory that holds a cognia `plugin.json`. We fetch + parse
// the catalog into browse-grid entries; install of any entry routes through
// the GitHub source adapter (`makeGithubMarketplaceClient`) using the entry's
// `{ owner, repo, ref, subdir }` origin.

import type { PluginMarketplaceEntry } from "@/hooks/plugins/use-plugin-marketplace"
import { parseGithubPluginRef, fetchGithubFile, type GithubPluginRef } from "./github-source"

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
  /** Display name from the catalog, or the repo reference as a fallback. */
  name: string
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
  for (const path of CATALOG_PATHS) {
    raw = await fetchGithubFile(ref, path)
    if (raw !== null) break
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

  return { name: catalog.name?.trim() || repoLabel, entries }
}

/**
 * Fetch every saved source's catalog, returning the merged entry list.
 * Per-source failures are swallowed (a removed / renamed repo shouldn't blank
 * the whole grid) and reported via the returned `errors` list.
 */
export async function fetchAllSourceEntries(repoRefs: string[]): Promise<{
  entries: GithubMarketplaceEntry[]
  errors: Array<{ repoRef: string; message: string }>
}> {
  const entries: GithubMarketplaceEntry[] = []
  const errors: Array<{ repoRef: string; message: string }> = []
  await Promise.all(
    repoRefs.map(async (repoRef) => {
      try {
        const catalog = await fetchMarketplaceCatalog(repoRef)
        entries.push(...catalog.entries)
      } catch (err) {
        errors.push({ repoRef, message: err instanceof Error ? err.message : String(err) })
      }
    })
  )
  return { entries, errors }
}
