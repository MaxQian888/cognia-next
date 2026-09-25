"use client"

// Floating toolbar that appears when one or more plugin rows are selected
// in the InstalledTab grid. Drives off `usePluginsStore.selection` and
// dispatches enable/disable/uninstall through the same host paths the single
// row uses. Uninstall queues a delete confirmation per row so the user gets
// the cascade option.
//
// Bulk enable/disable is a sequence of real activations (seconds each), so the
// bar shows it: the buttons are disabled while it runs, the toggle says how far
// it got, and the outcome is ONE summary toast (applied / queued / failed, with
// the failed plugin names) instead of silence or N separate toasts.

import { useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { localizePluginText } from "@/hooks/plugins/use-localized-plugin-text"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { DownloadIcon, PowerIcon, Trash2Icon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import {
  evaluatePluginEnableGate,
  useEffectivePluginRuntimeProfile,
} from "@/hooks/plugins/use-plugin-enable-gate"
import { pluginUninstallBlockReason } from "@/hooks/plugins/use-plugin-uninstall"
import { listPlugins } from "@/lib/db/plugins"
import { setPluginEnabledForHost } from "@/lib/plugin/core/set-plugin-enabled-for-host"
import { cn } from "@/lib/utils"
import type { PluginRow } from "@/lib/db/plugin-types"
import { usePluginsStore } from "@/stores/plugins"

function hasUpdate(row: PluginRow): boolean {
  return !!(row.manifest as { updateAvailable?: boolean })?.updateAvailable
}

export interface PluginBatchActionsBarProps {
  /**
   * Extra classes for the floating bar.
   *
   * The bar is mounted by BOTH shells — `PluginPanel` on the desktop and
   * `PluginsMobileBody` on `/plugins` and `/me/plugins` — and only one of them
   * has a `MobileTabBar` under it, so the offset is the caller's to state.
   * Compact callers pass `COMPACT_ABOVE_TAB_BAR_BOTTOM`; the default below
   * clears the safe area only, which is right where there is no tab bar and
   * inside it where there is.
   *
   * Merged through `cn()`, so a `bottom-*` here REPLACES the default rather
   * than racing it on stylesheet order.
   */
  className?: string
}

export function PluginBatchActionsBar({ className }: PluginBatchActionsBarProps = {}) {
  const t = useTranslations("plugins.batchActions")
  const locale = useLocale()
  const tLifecycle = useTranslations("plugins.lifecycleFeedback")
  const selection = usePluginsStore((s) => s.selection)
  const clearSelection = usePluginsStore((s) => s.clearSelection)
  const enqueueDeleteTargets = usePluginsStore((s) => s.enqueueDeleteTargets)
  const clearDeleteQueue = usePluginsStore((s) => s.clearDeleteQueue)
  const rows = useLiveQuery(() => listPlugins(), [])
  const profile = useEffectivePluginRuntimeProfile()
  const [updating, setUpdating] = useState(false)
  const [toggling, setToggling] = useState<{ done: number; total: number } | null>(null)

  if (selection.size === 0) return null

  const targets = (rows ?? []).filter((r) => selection.has(r.id))
  const allEnabled = targets.every((r) => r.enabled)
  const updatable = targets.filter(hasUpdate)
  const busy = toggling !== null || updating

  const handleToggleAll = async () => {
    const next = !allEnabled
    // A plugin this host cannot run is skipped rather than started into a
    // certain failure (the same gate the single-row toggle applies).
    const runnable = next
      ? targets.filter((row) => !evaluatePluginEnableGate(row.manifest, profile).blocked)
      : targets
    const skipped = targets.length - runnable.length
    let applied = 0
    let queued = 0
    const failed: string[] = []
    setToggling({ done: 0, total: runnable.length })
    try {
      // Sequential rather than Promise.all: each toggle runs a real
      // activation, and `withLifecycleLock` would serialize them anyway —
      // firing them all at once just queues N long operations behind one lock
      // while the UI shows nothing about which is in flight.
      for (const [index, target] of runnable.entries()) {
        const result = await setPluginEnabledForHost(target.id, next, "batch")
        if (!result.ok) failed.push(target.name)
        else if (result.queued) queued++
        else applied++
        setToggling({ done: index + 1, total: runnable.length })
      }
    } finally {
      setToggling(null)
    }
    const summary = t("toggleResult", { applied, queued, failed: failed.length, skipped })
    if (failed.length > 0) {
      toast.error(summary, { description: t("toggleFailedNames", { names: failed.join(", ") }) })
    } else if (queued > 0) {
      toast.message(summary, { description: tLifecycle("queuedHint") })
    } else {
      toast.success(summary)
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
    // Built-ins and mirrored rows cannot be uninstalled here; queueing them
    // would walk the user through confirms that could only fail.
    const removable = targets.filter((row) => pluginUninstallBlockReason(row) === null)
    const skipped = targets.length - removable.length
    if (skipped > 0) toast.message(t("uninstallSkipped", { count: skipped }))
    if (removable.length === 0) return
    // Push every selected plugin into the delete queue — the dialog host
    // pops them one at a time on confirm/cancel so the user walks the
    // whole selection through a single batch action.
    enqueueDeleteTargets(
      removable.map((row) => ({
        pluginId: row.id,
        name: localizePluginText(row, locale).name,
      }))
    )
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
      className={cn(
        "fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-30 flex flex-row flex-wrap items-center justify-center gap-2 px-4 py-2 shadow-lg overflow-hidden max-w-[min(calc(100vw-1rem),32rem)]",
        className
      )}
      role="region"
      aria-label={t("ariaLabel")}
      aria-busy={busy || undefined}
    >
      <Badge variant="secondary" className="text-xs">
        {t("selected", { count: selection.size })}
      </Badge>
      <div className="h-4 w-px bg-border mx-1" />
      <Button
        size="sm"
        variant="ghost"
        className="pointer-coarse:h-9"
        onClick={() => void handleToggleAll()}
        disabled={busy}
        aria-label={allEnabled ? t("disableAll") : t("enableAll")}
        data-testid="plugin-batch-toggle"
      >
        {toggling ? (
          <Spinner className="size-3.5 sm:mr-1.5" />
        ) : (
          <PowerIcon className="size-3.5 sm:mr-1.5" />
        )}
        <span className="hidden sm:inline">
          {toggling
            ? t("toggling", { done: toggling.done, total: toggling.total })
            : allEnabled
              ? t("disableAll")
              : t("enableAll")}
        </span>
      </Button>
      {/* The progress text is hidden on narrow bars with the label; say it to
          assistive tech either way. */}
      <span className="sr-only" role="status" aria-live="polite">
        {toggling ? t("toggling", { done: toggling.done, total: toggling.total }) : ""}
      </span>
      {updatable.length > 0 && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void handleUpdateAll()}
          disabled={busy}
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
        disabled={busy}
        aria-label={t("uninstall")}
      >
        <Trash2Icon className="size-3.5 sm:mr-1.5" />
        <span className="hidden sm:inline">{t("uninstall")}</span>
      </Button>
      <div className="h-4 w-px bg-border mx-1" />
      <Button
        size="icon"
        variant="ghost"
        className="size-7 pointer-coarse:size-9"
        onClick={handleClearSelection}
        disabled={busy}
        aria-label={t("clearSelection")}
      >
        <XIcon className="size-3.5" />
      </Button>
    </Card>
  )
}
