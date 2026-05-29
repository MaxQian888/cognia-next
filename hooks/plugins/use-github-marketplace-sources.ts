"use client"

// Reads the saved GitHub "marketplace repo" sources (Dexie) and fetches their
// catalogs into browse-grid entries. Keeps the source list reactive via
// `useLiveQuery`; refetches catalog entries whenever the set of sources
// changes. Add/remove mutate Dexie (and validate the repo on add).

import { useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  listMarketplaceSources,
  addMarketplaceSource,
  removeMarketplaceSource,
} from "@/lib/db/plugin-marketplace-sources"
import {
  fetchAllSourceEntries,
  fetchMarketplaceCatalog,
  type GithubMarketplaceEntry,
} from "@/lib/plugin/package/github-marketplace"
import { parseGithubPluginRef } from "@/lib/plugin/package/github-source"
import type { PluginMarketplaceSourceRow } from "@/lib/db/plugin-types"

export interface UseGithubMarketplaceSources {
  sources: PluginMarketplaceSourceRow[]
  entries: GithubMarketplaceEntry[]
  loading: boolean
  errors: Array<{ repoRef: string; message: string }>
  /** Validate + persist a new source. Throws when the repo has no catalog. */
  add: (repoRef: string) => Promise<void>
  remove: (id: string) => Promise<void>
  /** Re-fetch all source catalogs. */
  refresh: () => Promise<void>
}

/** Canonical `owner/repo[@ref]` id for a source reference. */
export function canonicalSourceId(repoRef: string): string {
  const ref = parseGithubPluginRef(repoRef)
  return `${ref.owner}/${ref.repo}${ref.ref ? `@${ref.ref}` : ""}`
}

export function useGithubMarketplaceSources(): UseGithubMarketplaceSources {
  const sources = useLiveQuery(() => listMarketplaceSources(), [], [])
  const [entries, setEntries] = useState<GithubMarketplaceEntry[]>([])
  const [errors, setErrors] = useState<Array<{ repoRef: string; message: string }>>([])
  const [loading, setLoading] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const repoRefs = useMemo(() => (sources ?? []).map((s) => s.repoRef), [sources])
  const repoRefsKey = repoRefs.join("|")
  // Monotonic request id so a slow in-flight fetch can't overwrite the results
  // of a newer one (the effect kicks off `loadEntries`, which keeps the actual
  // setState out of the effect body).
  const requestIdRef = useRef(0)

  const loadEntries = async (refs: string[]) => {
    // Detach from the effect's synchronous tick so the rule against synchronous
    // setState-in-effect is satisfied — nothing below runs in the same tick as
    // the effect body that kicks this off.
    await Promise.resolve()
    const id = ++requestIdRef.current
    setLoading(true)
    try {
      const result = await fetchAllSourceEntries(refs)
      if (id !== requestIdRef.current) return
      setEntries(result.entries)
      setErrors(result.errors)
    } finally {
      if (id === requestIdRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    // Schedule the fetch on a microtask (mirrors use-system-scheduler) so the
    // effect body never synchronously traces into a setState call.
    if (repoRefs.length > 0) void Promise.resolve().then(() => loadEntries(repoRefs))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoRefsKey, reloadKey])

  // With no sources there is nothing to fetch, so any previously-fetched
  // entries/errors are stale — mask them to empty rather than clearing state
  // synchronously inside the effect.
  const hasSources = repoRefs.length > 0

  return useMemo(
    () => ({
      sources: sources ?? [],
      entries: hasSources ? entries : [],
      loading,
      errors: hasSources ? errors : [],
      add: async (repoRef: string) => {
        const id = canonicalSourceId(repoRef)
        // Validate the repo actually hosts a catalog before persisting.
        const catalog = await fetchMarketplaceCatalog(repoRef)
        await addMarketplaceSource({ id, repoRef, name: catalog.name })
      },
      remove: async (id: string) => {
        await removeMarketplaceSource(id)
      },
      refresh: async () => setReloadKey((k) => k + 1),
    }),
    [sources, entries, loading, errors, hasSources]
  )
}
