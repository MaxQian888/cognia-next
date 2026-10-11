"use client"

/**
 * Bulk actions for the rows selected in `/memory`.
 *
 * A flat bar, not a bordered box: it sits in the list's own band — under the
 * header on a wide window, in the sticky header on a phone (where the tab bar
 * owns the bottom edge) — and reads as part of the list rather than a card
 * dropped on top of it.
 *
 * What it offers follows what the selection can do. In the Archived view the
 * rows are already out of recall, so the soft action is Restore; everywhere
 * else it is Archive, which runs at once and is undone from its toast. Delete
 * is the only permanent action, and the console confirms it before anything
 * runs.
 */

import { useTranslations } from "next-intl"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"

export interface MemoryBulkToolbarProps {
  selectedCount: number
  /** Number of currently-visible rows (drives the select-all checkbox state). */
  visibleCount: number
  allSelected: boolean
  onToggleSelectAll: (checked: boolean) => void
  /** True in the Archived view: Restore replaces Archive, pinning is hidden. */
  archivedView?: boolean
  onPin: () => void
  onUnpin: () => void
  /** Soft delete — drops the rows out of recall; undone from the toast. */
  onArchive: () => void
  onRestore: () => void
  /** Request a permanent delete; the console confirms it. */
  onDelete: () => void
  onClear: () => void
  /** Disables every action while a bulk mutation is in flight. */
  busy?: boolean
  /** `bar`: labelled buttons on a wide layout. `compact`: icon buttons for touch. */
  layout?: "bar" | "compact"
}

export function MemoryBulkToolbar({
  selectedCount,
  visibleCount,
  allSelected,
  onToggleSelectAll,
  archivedView = false,
  onPin,
  onUnpin,
  onArchive,
  onRestore,
  onDelete,
  onClear,
  busy = false,
  layout = "bar",
}: MemoryBulkToolbarProps) {
  const t = useTranslations("memory.bulk")
  const compact = layout === "compact"
  // Icon-only when compact: four labelled buttons do not fit a phone row, and
  // every icon keeps its label for assistive tech.
  const label = (text: string) => (compact ? <span className="sr-only">{text}</span> : text)
  const size = compact ? "icon" : "sm"
  const noSelection = selectedCount === 0

  return (
    <div
      role="toolbar"
      aria-label={t("toolbarLabel")}
      className={cn(
        "flex items-center gap-1.5",
        compact ? "px-3 py-1" : "border-b bg-muted/40 px-3 py-1.5"
      )}
      data-testid="memory-bulk-toolbar"
      data-layout={layout}
    >
      <Checkbox
        checked={allSelected && visibleCount > 0}
        onCheckedChange={(value) => onToggleSelectAll(value === true)}
        aria-label={t("selectAll")}
        className={compact ? "size-5" : undefined}
        data-testid="memory-bulk-select-all"
      />
      <span className="min-w-0 truncate text-sm font-medium" data-testid="memory-bulk-count">
        {t("selected", { count: selectedCount })}
      </span>
      <span className="flex-1" />
      {archivedView ? (
        <Button
          size={size}
          variant="ghost"
          disabled={busy || noSelection}
          onClick={onRestore}
          data-testid="memory-bulk-restore"
        >
          <ArchiveRestoreIcon className="size-4" />
          {label(t("restore"))}
        </Button>
      ) : (
        <>
          <Button
            size={size}
            variant="ghost"
            disabled={busy || noSelection}
            onClick={onPin}
            data-testid="memory-bulk-pin"
          >
            <PinIcon className="size-4" />
            {label(t("pin"))}
          </Button>
          <Button
            size={size}
            variant="ghost"
            disabled={busy || noSelection}
            onClick={onUnpin}
            data-testid="memory-bulk-unpin"
          >
            <PinOffIcon className="size-4" />
            {label(t("unpin"))}
          </Button>
          <Button
            size={size}
            variant="ghost"
            disabled={busy || noSelection}
            onClick={onArchive}
            data-testid="memory-bulk-archive"
          >
            <ArchiveIcon className="size-4" />
            {label(t("archive"))}
          </Button>
        </>
      )}
      <Button
        size={size}
        variant="ghost"
        className="text-destructive hover:text-destructive"
        disabled={busy || noSelection}
        onClick={onDelete}
        data-testid="memory-bulk-delete"
      >
        <Trash2Icon className="size-4" />
        {label(t("delete"))}
      </Button>
      <Button
        size={compact ? "icon" : "icon-sm"}
        variant="ghost"
        disabled={busy}
        onClick={onClear}
        aria-label={t("clear")}
        data-testid="memory-bulk-clear"
      >
        <XIcon className="size-4" />
      </Button>
    </div>
  )
}
