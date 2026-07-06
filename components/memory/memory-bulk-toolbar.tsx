"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PinIcon, PinOffIcon, Trash2Icon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ConfirmActionDialog } from "@/components/agent/workspace/settings/confirm-action-dialog"

export interface MemoryBulkToolbarProps {
  selectedCount: number
  /** Number of currently-visible rows (drives the select-all checkbox state). */
  visibleCount: number
  allSelected: boolean
  onToggleSelectAll: (checked: boolean) => void
  onPin: () => void
  onUnpin: () => void
  onDelete: () => void
  onClear: () => void
}

/**
 * Bulk-action bar shown above the memory list once ≥1 row is selected. Pins,
 * unpins, or hard-deletes (with confirmation) the current selection.
 */
export function MemoryBulkToolbar({
  selectedCount,
  visibleCount,
  allSelected,
  onToggleSelectAll,
  onPin,
  onUnpin,
  onDelete,
  onClear,
}: MemoryBulkToolbarProps) {
  const t = useTranslations("memory.bulk")
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2"
      data-testid="memory-bulk-toolbar"
    >
      <Checkbox
        checked={allSelected && visibleCount > 0}
        onCheckedChange={(v) => onToggleSelectAll(v === true)}
        aria-label={t("selectAll")}
        data-testid="memory-bulk-select-all"
      />
      <span className="text-sm font-medium" data-testid="memory-bulk-count">
        {t("selected", { count: selectedCount })}
      </span>
      <div className="flex-1" />
      <Button size="sm" variant="outline" onClick={onPin}>
        <PinIcon className="size-4" />
        {t("pin")}
      </Button>
      <Button size="sm" variant="outline" onClick={onUnpin}>
        <PinOffIcon className="size-4" />
        {t("unpin")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="text-destructive hover:text-destructive"
        onClick={() => setConfirmDelete(true)}
      >
        <Trash2Icon className="size-4" />
        {t("delete")}
      </Button>
      <Button size="sm" variant="ghost" onClick={onClear} aria-label={t("clear")}>
        <XIcon className="size-4" />
      </Button>

      <ConfirmActionDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("deleteConfirm.title")}
        description={t("deleteConfirm.description", { count: selectedCount })}
        confirmLabel={t("deleteConfirm.confirm")}
        cancelLabel={t("deleteConfirm.cancel")}
        tone="destructive"
        onConfirm={onDelete}
      />
    </div>
  )
}
