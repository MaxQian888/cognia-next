"use client"

/**
 * "Refresh the catalog and tell me which installed plugins have a newer
 * version", as one hook.
 *
 * This lived inline in `components/plugins/plugin-panel.tsx` and was reachable
 * only from that panel's toolbar, so the phone surface had no way to ask the
 * same question. Extracting it keeps ONE implementation of the two rules that
 * make the answer correct:
 *
 *   - VS Code extensions are excluded from the cognia registry check. Their ids
 *     (`esbenp.prettier-vscode`) can never resolve there, and asking would tell
 *     cognia's registry which extensions this user has. `PluginUpdater` checks
 *     them against Open VSX instead, routed by the same field.
 *   - `manifest.updateAvailable` is written only when it actually changes, so a
 *     sync over a large library is not a full table rewrite.
 *
 * It is also the only moment `manifest.rating` and `manifest.downloads` can be
 * refreshed. The library offered a "rating" sort that read `manifest.rating`,
 * and no install path ever wrote that field, so the option was permanently
 * equivalent to no sort at all. The catalog carries both numbers, and this is
 * the one place the catalog and the installed rows meet.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { listPlugins, updatePlugin } from "@/lib/db/plugins"

import { loadPluginMarketplaceClient } from "./use-plugin-marketplace"

export interface PluginRegistrySync {
  syncing: boolean
  /** Never rejects. Failures surface as a toast, like the toolbar expects. */
  sync: () => Promise<void>
}

interface PluginManifestMetrics {
  updateAvailable?: boolean
  rating?: number
  downloads?: number
}

/**
 * The catalog's rating / download numbers, keyed by plugin id.
 *
 * Best-effort: a registry that cannot answer leaves the installed manifests
 * exactly as they were, which keeps the sort honest rather than zeroing every
 * rating on a bad network.
 */
async function readCatalogMetrics(): Promise<Map<string, { rating?: number; downloads?: number }>> {
  try {
    const client = await loadPluginMarketplaceClient()
    const result = await client.searchPlugins({ query: "" })
    const entries = Array.isArray(result)
      ? result
      : ((result as { entries?: unknown; plugins?: unknown }).entries ??
        (result as { plugins?: unknown }).plugins ??
        [])
    if (!Array.isArray(entries)) return new Map()
    return new Map(
      entries
        .filter((e): e is { id: string; rating?: number; downloads?: number } =>
          Boolean(e && typeof (e as { id?: unknown }).id === "string")
        )
        .map((e) => [
          e.id,
          {
            rating: typeof e.rating === "number" ? e.rating : undefined,
            downloads: typeof e.downloads === "number" ? e.downloads : undefined,
          },
        ])
    )
  } catch {
    return new Map()
  }
}

interface MarketplaceUpdateChecker {
  getPluginMarketplace: () => {
    checkForUpdates: (
      installed: { id: string; version: string }[]
    ) => Promise<{ id: string; latestVersion: string }[]>
  }
}

export function usePluginRegistrySync(refreshCatalog: () => Promise<void>): PluginRegistrySync {
  const t = useTranslations("plugins.toolbar")
  const [syncing, setSyncing] = useState(false)

  const sync = useCallback(async () => {
    setSyncing(true)
    try {
      await refreshCatalog()
      const rows = await listPlugins()
      const mod =
        (await import("@/lib/plugin/package/marketplace")) as unknown as MarketplaceUpdateChecker
      const cogniaRows = rows.filter((r) => r.type !== "vscode-extension")
      const updates = await mod
        .getPluginMarketplace()
        .checkForUpdates(cogniaRows.map((r) => ({ id: r.id, version: r.version })))
      const updateIds = new Set(updates.map((u) => u.id))
      const catalog = await readCatalogMetrics()

      await Promise.all(
        rows.map((row) => {
          const manifest = row.manifest as PluginManifestMetrics
          const wantsFlag = updateIds.has(row.id)
          const metrics = catalog.get(row.id)
          const nextRating = metrics?.rating ?? manifest.rating
          const nextDownloads = metrics?.downloads ?? manifest.downloads
          if (
            wantsFlag === !!manifest.updateAvailable &&
            nextRating === manifest.rating &&
            nextDownloads === manifest.downloads
          ) {
            return Promise.resolve()
          }
          return updatePlugin(row.id, {
            manifest: {
              ...row.manifest,
              updateAvailable: wantsFlag,
              ...(nextRating === undefined ? {} : { rating: nextRating }),
              ...(nextDownloads === undefined ? {} : { downloads: nextDownloads }),
            },
          })
        })
      )
      toast.success(t("syncDone", { count: updateIds.size }))
    } catch (err) {
      // Callers fire this with `void`, so a rejection here becomes an
      // unhandled rejection over a UI that just sits there.
      toast.error(t("syncFailed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setSyncing(false)
    }
  }, [refreshCatalog, t])

  return { syncing, sync }
}
