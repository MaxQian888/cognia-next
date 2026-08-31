"use client"

// View-model for the /plugins panel — wraps `lib/db/plugins.listPlugins`
// with Dexie live-query, then layers the in-memory store filters on top
// (mirror of `hooks/skills/use-skills.ts`).

import { createContext, useContext, useDeferredValue, useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { listPlugins } from "@/lib/db/plugins"
import type { PluginRow } from "@/lib/db/plugin-types"
import { pluginExposesConfig } from "@/lib/plugin/core/plugin-config-detect"
import { usePluginsStore, type PluginFilters } from "@/stores/plugins"

export interface PluginsView {
  /** Raw rows from Dexie (unfiltered, unsorted). */
  all: PluginRow[]
  /** After applying current filters and sort. */
  filtered: PluginRow[]
  /** Aggregated counts by source. */
  countsBySource: Record<string, number>
  /** Aggregated counts by capability (multi-entry — a plugin contributes
   * to every capability it declares). */
  countsByCapability: Record<string, number>
  /** Aggregated counts by status. */
  countsByStatus: Record<string, number>
  /** Counts of enabled / disabled / errored / loading. */
  totals: {
    total: number
    enabled: number
    errored: number
    loading: number
    updateAvailable: number
  }
  loading: boolean
}

// Shared view context — `PluginsViewProvider` (use-plugins-provider.tsx)
// runs ONE live-query + buildView for the whole /plugins panel; without it
// every consumer (header, sub-filter chips, category rail, list, grid,
// detail-empty) opened its own Dexie subscription and re-filtered the same
// rows in parallel. `usePlugins()` falls back to a standalone query when no
// provider is mounted, so embedded reuse (Settings overlay, stories, tests)
// keeps working unchanged.
export const PluginsViewContext = createContext<PluginsView | null>(null)

export function usePlugins(): PluginsView {
  const shared = useContext(PluginsViewContext)
  const hasShared = shared !== null
  // When a provider supplies the view, the querier touches no Dexie table,
  // so this live-query never re-fires — hooks stay unconditional without a
  // duplicate subscription.
  const rows = useLiveQuery(() => (hasShared ? undefined : listPlugins()), [hasShared])
  const filters = usePluginsStore((s) => s.filters)
  // Defer filter application so fast keystrokes in the search input update
  // the input immediately and re-filter the (potentially large) list at
  // lower priority.
  const deferredFilters = useDeferredValue(filters)
  // Pass `rows` (possibly undefined) straight through so buildView can
  // distinguish "no live-query response yet" (loading) from "rows resolved
  // to []" (empty database) — `rows ?? null` collapsed both cases.
  const standalone = useMemo(() => buildView(rows, deferredFilters), [rows, deferredFilters])
  return shared ?? standalone
}

export function buildView(rows: PluginRow[] | undefined, filters: PluginFilters): PluginsView {
  const all = rows ?? []
  const countsBySource: Record<string, number> = {}
  const countsByCapability: Record<string, number> = {}
  const countsByStatus: Record<string, number> = {}
  let enabled = 0
  let errored = 0
  let loading = 0
  let updateAvailable = 0

  for (const row of all) {
    countsBySource[row.source] = (countsBySource[row.source] ?? 0) + 1
    countsByStatus[row.status] = (countsByStatus[row.status] ?? 0) + 1
    for (const cap of row.capabilities) {
      countsByCapability[cap] = (countsByCapability[cap] ?? 0) + 1
    }
    if (row.enabled) enabled++
    if (row.status === "error") errored++
    if (row.status === "loading" || row.status === "enabling" || row.status === "updating") {
      loading++
    }
    if ((row.manifest as { updateAvailable?: boolean })?.updateAvailable) {
      updateAvailable++
    }
  }

  const filtered = applyFilters(all, filters).sort(sortFor(filters.sort))

  return {
    all,
    filtered,
    countsBySource,
    countsByCapability,
    countsByStatus,
    totals: {
      total: all.length,
      enabled,
      errored,
      loading,
      updateAvailable,
    },
    loading: rows === undefined,
  }
}

/** `manifest.author` is `string | { name }` depending on the manifest's age. */
function readAuthor(manifest: PluginRow["manifest"]): string {
  const author = (manifest as { author?: string | { name?: string } })?.author
  const name = typeof author === "string" ? author : (author?.name ?? "")
  return name.toLowerCase()
}

function readKeywords(manifest: PluginRow["manifest"]): string[] {
  const raw = (manifest as { keywords?: unknown })?.keywords
  if (!Array.isArray(raw)) return []
  return raw.filter((k): k is string => typeof k === "string").map((k) => k.toLowerCase())
}

function applyFilters(rows: PluginRow[], filters: PluginFilters): PluginRow[] {
  const q = filters.query.trim().toLowerCase()
  return rows.filter((row) => {
    if (filters.source !== "all" && row.source !== filters.source) return false
    if (filters.status !== "all" && row.status !== filters.status) return false
    if (filters.capability !== "all" && !row.capabilities.includes(filters.capability)) {
      return false
    }
    if (filters.permission !== "all") {
      const perms = (row.manifest as { permissions?: string[] })?.permissions ?? []
      if (!perms.includes(filters.permission)) return false
    }
    if (filters.signedOnly) {
      const signed = !!(row.manifest as { signature?: { verified?: boolean } })?.signature?.verified
      if (!signed) return false
    }
    if (filters.hasUpdate) {
      const hasUpdate = !!(row.manifest as { updateAvailable?: boolean })?.updateAvailable
      if (!hasUpdate) return false
    }
    if (filters.tag) {
      // `PluginFilters.tag` was declared and defaulted to null, and no
      // component set it and no selector applied it. It is what a keyword
      // chip writes, so it has to actually narrow the list.
      const keywords = readKeywords(row.manifest)
      if (!keywords.includes(filters.tag.toLowerCase())) return false
    }
    if (filters.configurable && !pluginExposesConfig(row)) {
      // Matches the retired "Plugin configuration" settings section: a plugin
      // is configurable if it ships a configSchema with properties OR a custom
      // configComponent.
      return false
    }
    if (q) {
      // Name / description / id only used to be searchable, so a user who
      // remembered the publisher or a keyword the manifest advertises had no
      // way to find the plugin by it.
      const description = (
        (row.manifest as { description?: string })?.description ?? ""
      ).toLowerCase()
      const author = readAuthor(row.manifest)
      const keywords = readKeywords(row.manifest)
      if (
        !row.name.toLowerCase().includes(q) &&
        !description.includes(q) &&
        !row.id.toLowerCase().includes(q) &&
        !author.includes(q) &&
        !keywords.some((keyword) => keyword.includes(q))
      ) {
        return false
      }
    }
    return true
  })
}

function sortFor(mode: PluginFilters["sort"]) {
  return (a: PluginRow, b: PluginRow): number => {
    if (mode === "updated") return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
    if (mode === "usage") return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)
    if (mode === "rating") {
      const ar = (a.manifest as { rating?: number })?.rating ?? 0
      const br = (b.manifest as { rating?: number })?.rating ?? 0
      return br - ar
    }
    return a.name.localeCompare(b.name)
  }
}
