"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ArchiveIcon, PinIcon, PinOffIcon, Trash2Icon, XIcon } from "lucide-react"
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
  /** Soft delete — drops the rows out of recall but keeps them restorable. */
  onArchive: () => void
  /** Permanent delete. Confirmed inside this component. */
  onDelete: () => void
  onClear: () => void
  /** Disables every action while a bulk mutation is in flight. */
  busy?: boolean
}

/**
 * Bulk-action bar shown above the memory list once at least one row is
 * selected. Pins, unpins, archives, or permanently deletes the selection —
 * both destructive paths confirm first, and archive is the softer default
 * because it keeps history and can be undone from the Archived view.
 */
export function MemoryBulkToolbar({
  selectedCount,
  visibleCount,
  allSelected,
  onToggleSelectAll,
  onPin,
  onUnpin,
  onArchive,
  onDelete,
  onClear,
  busy = false,
}: MemoryBulkToolbarProps) {
  const t = useTranslations("memory.bulk")
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)

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
      <Button size="sm" variant="outline" disabled={busy} onClick={onPin}>
        <PinIcon className="size-4" />
        {t("pin")}
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={onUnpin}>
        <PinOffIcon className="size-4" />
        {t("unpin")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => setConfirmArchive(true)}
        data-testid="memory-bulk-archive"
      >
        <ArchiveIcon className="size-4" />
        {t("archive")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="text-destructive hover:text-destructive"
        disabled={busy}
        onClick={() => setConfirmDelete(true)}
        data-testid="memory-bulk-delete"
      >
        <Trash2Icon className="size-4" />
        {t("delete")}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onClear} aria-label={t("clear")}>
        <XIcon className="size-4" />
      </Button>

      <ConfirmActionDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={t("archiveConfirm.title")}
        description={t("archiveConfirm.description", { count: selectedCount })}
        confirmLabel={t("archiveConfirm.confirm")}
        cancelLabel={t("archiveConfirm.cancel")}
        tone="warning"
        onConfirm={onArchive}
      />

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
