"use client"

/**
 * The phone's Files bulk dock (ADR-0223 §9): the last row of the page's
 * column while the list is in selection mode.
 *
 *   3 selected                               Select all · Done
 *   [Favorite]  [Move]  [Share]  [Download]  [Trash]
 *
 * In the Trash the actions are Restore and Delete forever. It sits in the
 * column rather than floating (`/files` owns the viewport on the compact
 * shell), so it cannot cover the last row. Every button is a 44px+ target
 * with an icon and a label, and each acts on the whole selection in one write
 * — the same actions as the desktop bar (`files-bulk-bar.tsx`).
 */

import { useTranslations } from "next-intl"
import {
  DownloadIcon,
  FolderInputIcon,
  RotateCcwIcon,
  Share2Icon,
  StarIcon,
  StarOffIcon,
  Trash2Icon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import { impact } from "@/lib/capacitor/haptics"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import type { FilesEntry } from "@/lib/files-library/types"
import { cn } from "@/lib/utils"
import { useFilesLibraryStore } from "@/stores/files-library"

export interface FilesMobileBulkBarProps {
  selected: readonly FilesEntry[]
  /** Items in view, for "Select all". */
  visibleCount: number
  folders: readonly LibraryFolder[]
  trash: boolean
  actions: Pick<FilesActions, "setFavorite" | "exportZip" | "trash" | "restore">
  onSelectAll: () => void
  onClear: () => void
  /** Leave selection mode. */
  onDone: () => void
}

const DOCK_BUTTON = cn(
  "flex h-auto min-h-14 flex-col items-center justify-center gap-1 rounded-none px-1 py-1.5",
  "text-[11px] font-medium leading-none [&_svg]:size-5"
)

function DockButton({
  label,
  icon: Icon,
  onClick,
  disabled,
  destructive = false,
  testId,
}: {
  label: string
  icon: React.ComponentType<{ "aria-hidden"?: boolean }>
  onClick: () => void
  disabled: boolean
  destructive?: boolean
  testId: string
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      className={cn(DOCK_BUTTON, destructive && "text-destructive hover:text-destructive")}
      disabled={disabled}
      onClick={() => {
        void impact("light")
        onClick()
      }}
      data-testid={testId}
    >
      <Icon aria-hidden />
      {label}
    </Button>
  )
}

export function FilesMobileBulkBar({
  selected,
  visibleCount,
  folders,
  trash,
  actions,
  onSelectAll,
  onClear,
  onDone,
}: FilesMobileBulkBarProps) {
  const t = useTranslations("files")
  const openMove = useFilesLibraryStore((s) => s.openMove)
  const openDeleteForever = useFilesLibraryStore((s) => s.openDeleteForever)
  const openShare = useFilesLibraryStore((s) => s.openShare)
  const count = selected.length
  const none = count === 0
  const allChecked = count > 0 && count >= visibleCount
  const keys = selected.map((entry) => entry.key)
  const allFavorite = !none && selected.every((entry) => entry.favoritedAt !== undefined)

  return (
    <div
      role="toolbar"
      aria-label={t("bulk.aria")}
      className="shrink-0 border-t bg-background pb-[env(safe-area-inset-bottom)]"
      data-testid="files-mobile-bulk-bar"
    >
      <div className="flex min-h-11 items-center gap-1 ps-4 pe-1">
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium tabular-nums"
          aria-live="polite"
          data-testid="files-mobile-bulk-count"
        >
          {none ? t("mobile.selectHint") : t("bulk.selected", { count })}
        </span>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 px-3 text-sm"
          onClick={allChecked ? onClear : onSelectAll}
          disabled={visibleCount === 0}
          data-testid="files-mobile-select-all"
        >
          {allChecked ? t("mobile.clear") : t("selection.selectAll")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 px-3 text-sm font-semibold"
          onClick={onDone}
          data-testid="files-mobile-select-done"
        >
          {t("mobile.done")}
        </Button>
      </div>
      {trash ? (
        <div className="grid grid-cols-2 border-t">
          <DockButton
            label={t("actions.restore")}
            icon={RotateCcwIcon}
            disabled={none}
            onClick={() => {
              void actions.restore(selected)
              onDone()
            }}
            testId="files-mobile-bulk-restore"
          />
          <DockButton
            label={t("actions.deleteForever")}
            icon={Trash2Icon}
            destructive
            disabled={none}
            onClick={() => openDeleteForever(keys)}
            testId="files-mobile-bulk-delete-forever"
          />
        </div>
      ) : (
        <div className="grid grid-cols-5 border-t">
          <DockButton
            label={allFavorite ? t("mobile.dock.unfavorite") : t("mobile.dock.favorite")}
            icon={allFavorite ? StarOffIcon : StarIcon}
            disabled={none}
            onClick={() => void actions.setFavorite(selected, !allFavorite)}
            testId="files-mobile-bulk-favorite"
          />
          <DockButton
            label={t("mobile.dock.move")}
            icon={FolderInputIcon}
            disabled={none}
            onClick={() => openMove(keys)}
            testId="files-mobile-bulk-move"
          />
          <DockButton
            label={t("mobile.dock.share")}
            icon={Share2Icon}
            disabled={none}
            onClick={() => openShare(keys)}
            testId="files-mobile-bulk-share"
          />
          <DockButton
            label={t("mobile.dock.download")}
            icon={DownloadIcon}
            disabled={none}
            onClick={() => void actions.exportZip(selected, folders)}
            testId="files-mobile-bulk-export"
          />
          <DockButton
            label={t("mobile.dock.trash")}
            icon={Trash2Icon}
            destructive
            disabled={none}
            onClick={() => {
              void actions.trash(selected)
              onDone()
            }}
            testId="files-mobile-bulk-trash"
          />
        </div>
      )}
    </div>
  )
}
