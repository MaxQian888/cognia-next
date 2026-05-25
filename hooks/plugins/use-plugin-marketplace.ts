"use client"

// Wraps lib/plugin/package/marketplace.ts so UI components can drive the
// marketplace panel without touching the singleton directly. Mirrors the
// ergonomic shape of hooks/skills/use-skill-marketplace.

import { useCallback, useEffect, useMemo, useState } from "react"
import type { PluginSource } from "@/types/plugin"

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
  /** Origin of the entry. Remote registry entries leave this undefined (treated
   * as "marketplace"); built-in plugins surfaced from Dexie set "builtin" so the
   * card / detail can render a read-only Built-in badge instead of install. */
  source?: PluginSource
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

export interface MarketplaceClient {
  searchPlugins: (opts: {
    query: string
  }) => Promise<{ entries: PluginMarketplaceEntry[] } | PluginMarketplaceEntry[]>
  getFeaturedPlugins?: () => Promise<PluginMarketplaceEntry[]>
  getPopularPlugins?: (limit?: number) => Promise<PluginMarketplaceEntry[]>
  getRecentPlugins?: (limit?: number) => Promise<PluginMarketplaceEntry[]>
  /**
   * Returns the marketplace registry entry (manifest + metadata) for a
   * specific plugin id. Used by the pre-install chain to read the manifest
   * before any Dexie write. The full marketplace client returns
   * `PluginRegistryEntry | null`; we re-state the relevant shape inline so
   * we don't pull in the full client type tree at this layer.
   */
  getPlugin: (id: string) => Promise<{
    manifest: import("@/types/plugin").PluginManifest
    name?: string
  } | null>
  /**
   * Lists every available version for `pluginId` from the marketplace
   * registry. Used by the detail sheet to render a version dropdown so
   * the user can downgrade / pin to a specific release rather than
   * always taking `latest`. Returns `[]` if the call is unsupported.
   *
   * The full marketplace client returns `PluginVersionInfo[]` with
   * extra fields (changelog, publishedAt, downloadUrl, checksum) — we
   * only need `version` here, so the looser shape is intentional.
   */
  getVersions?: (pluginId: string) => Promise<Array<{ version: string } & Record<string, unknown>>>
  installPlugin: (id: string, version?: string) => Promise<unknown>
  uninstallPlugin: (id: string) => Promise<unknown>
}

let cachedClient: MarketplaceClient | null = null

export async function loadPluginMarketplaceClient(): Promise<MarketplaceClient> {
  if (cachedClient) return cachedClient
  const mod = (await import("@/lib/plugin/package/marketplace")) as unknown as {
    getPluginMarketplace: () => MarketplaceClient
  }
  cachedClient = mod.getPluginMarketplace()
  return cachedClient
}

// Kept as the historical short name used inside this hook so the install /
// uninstall / refresh paths keep working unchanged.
const loadClient = loadPluginMarketplaceClient

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
