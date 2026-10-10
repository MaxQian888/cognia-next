"use client"

/**
 * The bar over the Files list while items are selected (ADR-0223): favorite,
 * move, export as a zip, share as one link and move to Trash — or, in the Trash, restore and
 * delete forever. Every action takes the whole selection and lands in one
 * write. Esc or "Clear" ends the selection.
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
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

export interface FilesBulkBarProps {
  selected: readonly FilesEntry[]
  folders: readonly LibraryFolder[]
  trash: boolean
  actions: Pick<FilesActions, "setFavorite" | "exportZip" | "trash" | "restore">
  onClear: () => void
}

function BulkButton({
  label,
  icon: Icon,
  onClick,
  testId,
  destructive = false,
}: {
  label: string
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
  testId: string
  destructive?: boolean
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={destructive ? "text-destructive hover:text-destructive" : undefined}
      data-testid={testId}
    >
      <Icon className="size-3.5 @lg/files-bulk:mr-1.5" />
      <span className="hidden @lg/files-bulk:inline">{label}</span>
    </Button>
  )
}

export function FilesBulkBar({ selected, folders, trash, actions, onClear }: FilesBulkBarProps) {
  const t = useTranslations("files")
  const openMove = useFilesLibraryStore((s) => s.openMove)
  const openDeleteForever = useFilesLibraryStore((s) => s.openDeleteForever)
  const openShare = useFilesLibraryStore((s) => s.openShare)
  if (selected.length === 0) return null
  const keys = selected.map((entry) => entry.key)
  const allFavorite = selected.every((entry) => entry.favoritedAt !== undefined)

  return (
    <div
      className="@container/files-bulk flex shrink-0 items-center gap-2 border-b bg-muted/50 px-4 py-2"
      role="toolbar"
      aria-label={t("bulk.aria")}
      data-testid="files-bulk-bar"
    >
      <span className="text-sm font-medium" aria-live="polite" data-testid="files-bulk-count">
        {t("bulk.selected", { count: selected.length })}
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        {trash ? (
          <>
            <BulkButton
              label={t("actions.restore")}
              icon={RotateCcwIcon}
              onClick={() => {
                void actions.restore(selected)
                onClear()
              }}
              testId="files-bulk-restore"
            />
            <BulkButton
              label={t("actions.deleteForever")}
              icon={Trash2Icon}
              destructive
              onClick={() => openDeleteForever(keys)}
              testId="files-bulk-delete-forever"
            />
          </>
        ) : (
          <>
            <BulkButton
              label={allFavorite ? t("actions.unfavorite") : t("actions.favorite")}
              icon={allFavorite ? StarOffIcon : StarIcon}
              onClick={() => void actions.setFavorite(selected, !allFavorite)}
              testId="files-bulk-favorite"
            />
            <BulkButton
              label={t("actions.moveToFolder")}
              icon={FolderInputIcon}
              onClick={() => openMove(keys)}
              testId="files-bulk-move"
            />
            <BulkButton
              label={t("bulk.export")}
              icon={DownloadIcon}
              onClick={() => void actions.exportZip(selected, folders)}
              testId="files-bulk-export"
            />
            <BulkButton
              label={t("actions.share")}
              icon={Share2Icon}
              onClick={() => openShare(keys)}
              testId="files-bulk-share"
            />
            <BulkButton
              label={t("actions.trash")}
              icon={Trash2Icon}
              destructive
              onClick={() => {
                void actions.trash(selected)
                onClear()
              }}
              testId="files-bulk-trash"
            />
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          aria-label={t("bulk.clear")}
          title={t("bulk.clear")}
          data-testid="files-bulk-clear"
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
