"use client"

/**
 * SchedulerBulkToolbar — sticky strip above the sidebar that appears when
 * one or more unified items are selected via their hover-revealed
 * checkboxes. Iterates the selection and dispatches Pause / Resume /
 * Delete actions through the per-kind source from
 * `SchedulerSourceRegistry`, mirroring the `dispatchUnified` pattern in
 * `app/scheduler/page.tsx`.
 */

import { useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import { Pause, Play, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { getSchedulerSourceRegistry } from "@/lib/scheduler/sources/registry"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

export interface SchedulerBulkToolbarProps {
  /** Items currently selected. The toolbar hides itself when this is empty. */
  selectedItems: UnifiedScheduledItem[]
  onClearSelection: () => void
  /** Optional override of the source registry (tests inject a stub). */
  registry?: ReturnType<typeof getSchedulerSourceRegistry>
}

export function SchedulerBulkToolbar({
  selectedItems,
  onClearSelection,
  registry,
}: SchedulerBulkToolbarProps) {
  const t = useTranslations("scheduler")
  const locale = useLocale()
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [working, setWorking] = useState(false)

  if (selectedItems.length === 0) return null

  const resolveRegistry = () => registry ?? getSchedulerSourceRegistry()

  async function dispatchAll(action: "pause" | "resume" | "delete"): Promise<void> {
    setWorking(true)
    try {
      const reg = resolveRegistry()
      const failed: string[] = []
      // Iterate sequentially; per-source operations may hit IndexedDB or
      // sidecars and parallelizing them risks lock contention.
      for (const item of selectedItems) {
        if (action === "pause" && !item.capabilities.pause) continue
        if (action === "resume" && !item.capabilities.pause) continue
        if (action === "delete" && !item.capabilities.delete) continue
        const source = reg.getSource(item.kind)
        if (!source) {
          failed.push(item.name)
          continue
        }
        try {
          await source[action](item.sourceId)
        } catch {
          // A bulk run keeps going past one bad item, but it must not pretend
          // the item succeeded: the loop used to swallow this entirely and
          // clear the selection, so a failed pause read as a done pause.
          failed.push(item.name)
        }
      }
      if (failed.length > 0) {
        // `Intl.ListFormat`, the same way the sidebar's source-error line does
        // it: "、" is right for zh-CN and wrong for English, and this is a
        // user-facing string like any other.
        const names = failed.slice(0, 5)
        let joined: string
        try {
          joined = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names)
        } catch {
          joined = names.join(", ")
        }
        // The title counts every failure; the body can only name five without
        // becoming a wall of text. Say so, or the two disagree and the rows the
        // list left out are unrecoverable — `onClearSelection()` below drops the
        // selection that was the only other way back to them.
        const hidden = failed.length - names.length
        toast.error(t("bulkPartialFailure", { count: failed.length }), {
          description: hidden > 0 ? `${joined} ${t("bulkPartialFailureMore", { hidden })}` : joined,
        })
      }
      onClearSelection()
    } finally {
      setWorking(false)
    }
  }

  const pausableCount = selectedItems.filter((i) => i.capabilities.pause).length
  const deletableCount = selectedItems.filter((i) => i.capabilities.delete).length

  return (
    <>
      <div
        data-testid="scheduler-bulk-toolbar"
        className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b bg-background/95 px-3 py-2 backdrop-blur"
      >
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            data-testid="bulk-clear"
            onClick={onClearSelection}
            aria-label={t("clearSelection") || "Clear selection"}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs font-medium" data-testid="bulk-count">
            <span data-testid="bulk-count-value">{selectedItems.length}</span>{" "}
            {t("selected") || "selected"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            data-testid="bulk-pause"
            disabled={working || pausableCount === 0}
            onClick={() => void dispatchAll("pause")}
          >
            <Pause className="mr-1.5 h-3.5 w-3.5" />
            {t("pause") || "Pause"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="bulk-resume"
            disabled={working || pausableCount === 0}
            onClick={() => void dispatchAll("resume")}
          >
            <Play className="mr-1.5 h-3.5 w-3.5" />
            {t("resume") || "Resume"}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            data-testid="bulk-delete"
            disabled={working || deletableCount === 0}
            onClick={() => setDeleteConfirmOpen(true)}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            {t("delete") || "Delete"}
          </Button>
        </div>
      </div>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("bulkDeleteTitle") || "Delete selected tasks?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {(
                t("bulkDeleteDescription") ||
                "This will delete {n} selected tasks across all kinds. This action cannot be undone."
              ).replace("{n}", String(deletableCount))}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel") || "Cancel"}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="bulk-delete-confirm"
              onClick={() => {
                setDeleteConfirmOpen(false)
                void dispatchAll("delete")
              }}
            >
              {t("delete") || "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
