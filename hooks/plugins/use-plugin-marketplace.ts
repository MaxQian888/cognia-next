"use client"

// Wraps lib/plugin/package/marketplace.ts so UI components can drive the
// marketplace panel without touching the singleton directly. Mirrors the
// ergonomic shape of hooks/skills/use-skill-marketplace.

import { useCallback, useEffect, useMemo, useState } from "react"

export type PluginMarketplaceQueryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; results: PluginMarketplaceEntry[] }
  | { kind: "error"; error: string }

export interface PluginMarketplaceEntry {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  rating?: number
  downloads?: number
  signed?: boolean
  /** "skill" | "plugin" — drives the install dispatch when the entry comes
   * through the unified Skills marketplace storefront. Defaults to "plugin"
   * when reached through the plugin marketplace. */
  type: string
}

export interface UsePluginMarketplace {
  query: string
  setQuery: (q: string) => void
  state: PluginMarketplaceQueryState
  featured: PluginMarketplaceEntry[]
  popular: PluginMarketplaceEntry[]
  recent: PluginMarketplaceEntry[]
  install: (id: string, version?: string) => Promise<void>
  uninstall: (id: string) => Promise<void>
  refresh: () => Promise<void>
  /** Tracks the currently installing entry id (for spinners). */
  installingId: string | null
}

interface MarketplaceClient {
  searchPlugins: (opts: {
    query: string
  }) => Promise<{ entries: PluginMarketplaceEntry[] } | PluginMarketplaceEntry[]>
  getFeaturedPlugins?: () => Promise<PluginMarketplaceEntry[]>
  getPopularPlugins?: (limit?: number) => Promise<PluginMarketplaceEntry[]>
  getRecentPlugins?: (limit?: number) => Promise<PluginMarketplaceEntry[]>
  installPlugin: (id: string, version?: string) => Promise<unknown>
  uninstallPlugin: (id: string) => Promise<unknown>
}

let cachedClient: MarketplaceClient | null = null

async function loadClient(): Promise<MarketplaceClient> {
  if (cachedClient) return cachedClient
  const mod = (await import("@/lib/plugin/package/marketplace")) as unknown as {
    getPluginMarketplace: () => MarketplaceClient
  }
  cachedClient = mod.getPluginMarketplace()
  return cachedClient
}

export function __resetPluginMarketplaceClientForTests(client: MarketplaceClient | null) {
  cachedClient = client
}

function unwrapEntries(
  result: Awaited<ReturnType<MarketplaceClient["searchPlugins"]>>
): PluginMarketplaceEntry[] {
  if (Array.isArray(result)) return result
  return result.entries
}

export function usePluginMarketplace(): UsePluginMarketplace {
  const [query, setQuery] = useState("")
  const [state, setState] = useState<PluginMarketplaceQueryState>({ kind: "idle" })
  const [featured, setFeatured] = useState<PluginMarketplaceEntry[]>([])
  const [popular, setPopular] = useState<PluginMarketplaceEntry[]>([])
  const [recent, setRecent] = useState<PluginMarketplaceEntry[]>([])
  const [installingId, setInstallingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setState({ kind: "loading" })
    try {
      const client = await loadClient()
      const [s, f, p, r] = await Promise.all([
        client.searchPlugins({ query }),
        client.getFeaturedPlugins?.() ?? Promise.resolve([]),
        client.getPopularPlugins?.(10) ?? Promise.resolve([]),
        client.getRecentPlugins?.(10) ?? Promise.resolve([]),
      ])
      setState({ kind: "ready", results: unwrapEntries(s) })
      setFeatured(f)
      setPopular(p)
      setRecent(r)
    } catch (err) {
      setState({
        kind: "error",
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, [query])

  const install = useCallback(async (id: string, version?: string) => {
    setInstallingId(id)
    try {
      const client = await loadClient()
      await client.installPlugin(id, version)
    } finally {
      setInstallingId(null)
    }
  }, [])

  const uninstall = useCallback(async (id: string) => {
    setInstallingId(id)
    try {
      const client = await loadClient()
      await client.uninstallPlugin(id)
    } finally {
      setInstallingId(null)
    }
  }, [])

  // Initial load — kept simple, no debounce here. Components that wire the
  // search box should debounce setQuery before calling refresh().
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 0)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return useMemo(
    () => ({
      query,
      setQuery,
      state,
      featured,
      popular,
      recent,
      install,
      uninstall,
      refresh,
      installingId,
    }),
    [query, state, featured, popular, recent, install, uninstall, refresh, installingId]
  )
}
