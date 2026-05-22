"use client"

// Floating toolbar that appears when one or more plugin rows are selected
// in the InstalledTab grid. Drives off `usePluginsStore.selection` and
// dispatches enable/disable/uninstall against the Dexie helpers. Uninstall
// queues a delete confirmation through `setDeleteTarget` for each row so
// the user gets the cascade option.

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { PowerIcon, Trash2Icon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { listPlugins, setPluginEnabled } from "@/lib/db/plugins"
import { usePluginsStore } from "@/stores/plugins"

export function PluginBatchActionsBar() {
  const t = useTranslations("plugins.batchActions")
  const selection = usePluginsStore((s) => s.selection)
  const clearSelection = usePluginsStore((s) => s.clearSelection)
  const enqueueDeleteTargets = usePluginsStore((s) => s.enqueueDeleteTargets)
  const clearDeleteQueue = usePluginsStore((s) => s.clearDeleteQueue)
  const rows = useLiveQuery(() => listPlugins(), [])

  if (selection.size === 0) return null

  const targets = (rows ?? []).filter((r) => selection.has(r.id))
  const allEnabled = targets.every((r) => r.enabled)

  const handleToggleAll = async () => {
    await Promise.all(targets.map((r) => setPluginEnabled(r.id, !allEnabled)))
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
      className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-30 flex flex-wrap items-center justify-center gap-2 px-4 py-2 shadow-lg overflow-hidden max-w-[min(calc(100vw-1rem),32rem)]"
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
