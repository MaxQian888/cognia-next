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
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { listPlugins, updatePlugin } from "@/lib/db/plugins"

export interface PluginRegistrySync {
  syncing: boolean
  /** Never rejects. Failures surface as a toast, like the toolbar expects. */
  sync: () => Promise<void>
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
      await Promise.all(
        rows.map((row) => {
          const wantsFlag = updateIds.has(row.id)
          const currentFlag = !!(row.manifest as { updateAvailable?: boolean }).updateAvailable
          if (wantsFlag === currentFlag) return Promise.resolve()
          return updatePlugin(row.id, {
            manifest: { ...row.manifest, updateAvailable: wantsFlag },
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
