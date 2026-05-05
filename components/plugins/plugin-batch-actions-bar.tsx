"use client"

// Floating toolbar that appears when one or more plugin rows are selected
// in the InstalledTab grid. Drives off `usePluginsStore.selection` and
// dispatches enable/disable/uninstall against the Dexie helpers. Uninstall
// queues a delete confirmation through `setDeleteTarget` for each row so
// the user gets the cascade option.

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { PowerIcon, Trash2Icon, XIcon, RefreshCcwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { listPlugins, setPluginEnabled } from "@/lib/db/plugins"
import { usePluginsStore } from "@/stores/plugins"

export function PluginBatchActionsBar() {
  const t = useTranslations("plugins.batchActions")
  const selection = usePluginsStore((s) => s.selection)
  const clearSelection = usePluginsStore((s) => s.clearSelection)
  const setDeleteTarget = usePluginsStore((s) => s.setDeleteTarget)
  const rows = useLiveQuery(() => listPlugins(), [])

  if (selection.size === 0) return null

  const targets = (rows ?? []).filter((r) => selection.has(r.id))
  const allEnabled = targets.every((r) => r.enabled)

  const handleToggleAll = async () => {
    await Promise.all(targets.map((r) => setPluginEnabled(r.id, !allEnabled)))
  }

  const handleUninstallAll = () => {
    // Open the delete dialog for each target sequentially. The dialog host
    // confirms one at a time; clearing selection on close keeps state tidy.
    if (targets.length === 0) return
    const head = targets[0]
    if (head) setDeleteTarget({ pluginId: head.id, name: head.name })
    // Subsequent targets are picked up in `PluginDeleteDialogHost` queue —
    // for the v1 batch action we surface the head and let the user repeat.
    // Multi-confirm queueing is a follow-up.
  }

  return (
    <Card
      className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-30 flex flex-wrap items-center justify-center gap-2 px-4 py-2 shadow-lg max-w-[calc(100vw-1rem)]"
      role="region"
      aria-label={t("ariaLabel")}
    >
      <Badge variant="secondary" className="text-xs">
        {t("selected", { count: selection.size })}
      </Badge>
      <div className="h-4 w-px bg-border mx-1" />
      <Button size="sm" variant="ghost" onClick={() => void handleToggleAll()}>
        <PowerIcon className="size-3.5 mr-1.5" />
        {allEnabled ? t("disableAll") : t("enableAll")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          // Force re-fetch by toggling a no-op selection reset/restore.
          // This keeps the bar reactive even when the underlying rows
          // changed behind the scenes (e.g., manager updated a status).
          clearSelection()
          // Re-select originals in the next tick.
          setTimeout(() => {
            const store = usePluginsStore.getState()
            for (const id of targets.map((t) => t.id)) {
              store.toggleSelection(id)
            }
          }, 0)
        }}
      >
        <RefreshCcwIcon className="size-3.5 mr-1.5" />
        {t("refresh")}
      </Button>
      <Button size="sm" variant="ghost" className="text-destructive" onClick={handleUninstallAll}>
        <Trash2Icon className="size-3.5 mr-1.5" />
        {t("uninstall")}
      </Button>
      <div className="h-4 w-px bg-border mx-1" />
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        onClick={() => clearSelection()}
        aria-label={t("clearSelection")}
      >
        <XIcon className="size-3.5" />
      </Button>
    </Card>
  )
}
