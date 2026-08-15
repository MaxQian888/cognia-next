"use client"

// Reactive access to the cached OpenRouter live-models catalog (Dexie v93).
// Live-queries the singleton row so the settings card updates the moment a sync
// completes, and primes the synchronous in-memory cache (`openrouter-catalog-sync`)
// that the model picker reads. Mirrors `use-models-dev-catalog.ts`.

import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getDb, type OpenRouterCatalogRow } from "@/lib/db/schema"
import {
  primeOpenRouterCatalogCache,
  syncOpenRouterCatalog,
} from "@/lib/ai/providers/openrouter-catalog-sync"

export interface UseOpenRouterCatalogResult {
  row: OpenRouterCatalogRow | undefined
  modelCount: number
  isSyncing: boolean
  error: string | null
  /** Fetch the live OpenRouter `/models` list. `apiKey` is optional (keyless
   * returns the full public catalog). */
  sync: (apiKey?: string) => Promise<void>
}

export interface UseOpenRouterCatalogOptions {
  /**
   * Subscribe to the catalog row. Defaults to `true`; pass `false` from a
   * host that only needs OpenRouter data while OpenRouter is the selected
   * provider — the row is large and the live query otherwise re-runs for
   * every table change regardless of which provider is on screen.
   */
  enabled?: boolean
}

export function useOpenRouterCatalog(
  options: UseOpenRouterCatalogOptions = {}
): UseOpenRouterCatalogResult {
  const enabled = options.enabled ?? true
  const row = useLiveQuery(
    () => (enabled ? getDb().openrouterCatalog.get("singleton") : undefined),
    [enabled]
  )
  const [isSyncing, setIsSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Keep the synchronous cache (read by getCachedOpenRouterCatalogModels) in sync.
  useEffect(() => {
    primeOpenRouterCatalogCache(row ?? null)
  }, [row])

  const sync = useCallback(async (apiKey?: string) => {
    setIsSyncing(true)
    setError(null)
    try {
      await syncOpenRouterCatalog(Date.now(), apiKey)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsSyncing(false)
    }
  }, [])

  return {
    row,
    modelCount: row?.models.length ?? 0,
    isSyncing,
    error,
    sync,
  }
}
