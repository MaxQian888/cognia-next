"use client"

// Floating toolbar that appears when one or more plugin rows are selected
// in the InstalledTab grid. Drives off `usePluginsStore.selection` and
// dispatches enable/disable/uninstall against the Dexie helpers. Uninstall
// queues a delete confirmation through `setDeleteTarget` for each row so
// the user gets the cascade option.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { DownloadIcon, PowerIcon, Trash2Icon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { listPlugins } from "@/lib/db/plugins"
import { togglePluginEnabled } from "@/lib/plugin/core/toggle-plugin-enabled"
import type { PluginRow } from "@/lib/db/plugin-types"
import { usePluginsStore } from "@/stores/plugins"

function hasUpdate(row: PluginRow): boolean {
  return !!(row.manifest as { updateAvailable?: boolean })?.updateAvailable
}

export function PluginBatchActionsBar() {
  const t = useTranslations("plugins.batchActions")
  const selection = usePluginsStore((s) => s.selection)
  const clearSelection = usePluginsStore((s) => s.clearSelection)
  const enqueueDeleteTargets = usePluginsStore((s) => s.enqueueDeleteTargets)
  const clearDeleteQueue = usePluginsStore((s) => s.clearDeleteQueue)
  const rows = useLiveQuery(() => listPlugins(), [])
  const [updating, setUpdating] = useState(false)

  if (selection.size === 0) return null

  const targets = (rows ?? []).filter((r) => selection.has(r.id))
  const allEnabled = targets.every((r) => r.enabled)
  const updatable = targets.filter(hasUpdate)

  const handleToggleAll = async () => {
    // Sequential rather than Promise.all: each toggle now runs a real
    // activation, and `withLifecycleLock` would serialize them anyway — firing
    // them all at once just queues N long operations behind one lock while the
    // UI shows nothing about which is in flight.
    for (const target of targets) {
      await togglePluginEnabled(target.id, !allEnabled)
    }
  }

  // Apply marketplace updates to every selected plugin that has one. Reuses
  // the same updater singleton the single-plugin update dialog drives, so the
  // install path can't drift. Failures are aggregated into one toast.
  const handleUpdateAll = async () => {
    if (updatable.length === 0) return
    setUpdating(true)
    try {
      const mod = (await import("@/lib/plugin/lifecycle/updater")) as unknown as {
        getPluginUpdater: () => {
          checkForUpdates: (
            ids?: string[]
          ) => Promise<{ pluginId: string; latestVersion: string }[]>
          installUpdate: (pluginId: string, version: string) => Promise<unknown>
        }
      }
      const updater = mod.getPluginUpdater()
      const updates = await updater.checkForUpdates(updatable.map((r) => r.id))
      let ok = 0
      let failed = 0
      await Promise.all(
        updates.map(async (u) => {
          try {
            await updater.installUpdate(u.pluginId, u.latestVersion)
            ok++
          } catch {
            failed++
          }
        })
      )
      toast(t("updateResult", { ok, failed }))
    } finally {
      setUpdating(false)
    }
  }

  const handleUninstallAll = () => {
    if (targets.length === 0) return
    // Push every selected plugin into the delete queue — the dialog host
    // pops them one at a time on confirm/cancel so the user walks the
    // whole selection through a single batch action.
    enqueueDeleteTargets(targets.map((row) => ({ pluginId: row.id, name: row.name })))
  }

  const handleClearSelection = () => {
    clearDeleteQueue()
    clearSelection()
  }

  return (
    <Card
      // `flex-row` is load-bearing: the base `Card` ships `flex-col`, so
      // without an explicit direction the bar stacks its badge/actions into a
      // tall vertical column (with the `w-px` dividers rendering as stray
      // horizontal rules). Forcing row + wrap keeps it a horizontal toolbar
      // that only wraps onto extra rows when genuinely too narrow.
      className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-30 flex flex-row flex-wrap items-center justify-center gap-2 px-4 py-2 shadow-lg overflow-hidden max-w-[min(calc(100vw-1rem),32rem)]"
      role="region"
      aria-label={t("ariaLabel")}
    >
      <Badge variant="secondary" className="text-xs">
        {t("selected", { count: selection.size })}
      </Badge>
      <div className="h-4 w-px bg-border mx-1" />
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void handleToggleAll()}
        aria-label={allEnabled ? t("disableAll") : t("enableAll")}
      >
        <PowerIcon className="size-3.5 sm:mr-1.5" />
        <span className="hidden sm:inline">{allEnabled ? t("disableAll") : t("enableAll")}</span>
      </Button>
      {updatable.length > 0 && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void handleUpdateAll()}
          disabled={updating}
          aria-label={t("updateAll", { count: updatable.length })}
        >
          <DownloadIcon className="size-3.5 sm:mr-1.5" />
          <span className="hidden sm:inline">
            {updating ? t("updating") : t("updateAll", { count: updatable.length })}
          </span>
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive"
        onClick={handleUninstallAll}
        aria-label={t("uninstall")}
      >
        <Trash2Icon className="size-3.5 sm:mr-1.5" />
        <span className="hidden sm:inline">{t("uninstall")}</span>
      </Button>
      <div className="h-4 w-px bg-border mx-1" />
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        onClick={handleClearSelection}
        aria-label={t("clearSelection")}
      >
        <XIcon className="size-3.5" />
      </Button>
    </Card>
  )
}
