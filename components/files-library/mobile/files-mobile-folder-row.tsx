"use client"

/**
 * A subfolder on a phone-width Files page (ADR-0223 §9), listed above the
 * folder's items the way the desktop list puts folder rows first:
 *
 *   [glyph]  Research                                       3 d    ⋯
 *            4 items
 *
 * A tap opens the folder; "⋯" (44px) carries the folder's own menu — new
 * subfolder, rename, color, icon, delete. Folders are not selectable and not
 * dragged here; re-parenting a folder is a desktop gesture.
 */

import { useLocale, useTranslations } from "next-intl"
import { ChevronRightIcon, MoreHorizontalIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import { relativeCompact } from "@/lib/notifications/functional-toast/relative-time"
import { useFilesLibraryStore } from "@/stores/files-library"

import { FilesFolderGlyph } from "../files-folder-glyph"
import { useFilesFolderMenu } from "../files-folder-menu"
import { FilesMenuNodes } from "../files-menu"

export interface FilesMobileFolderRowProps {
  folder: LibraryFolder
  /** Items filed directly in the folder. */
  itemCount: number
  actions: Pick<FilesActions, "setFolderStyle">
  now: number
}

export function FilesMobileFolderRow({
  folder,
  itemCount,
  actions,
  now,
}: FilesMobileFolderRowProps) {
  const t = useTranslations("files")
  const locale = useLocale()
  const setSection = useFilesLibraryStore((s) => s.setSection)
  const setFolderExpanded = useFilesLibraryStore((s) => s.setFolderExpanded)
  const nodes = useFilesFolderMenu(folder, actions)
  const open = () => {
    setFolderExpanded(folder.id, true)
    setSection({ kind: "folder", folderId: folder.id })
  }

  return (
    <li
      className="not-last:border-b flex min-w-0 items-center gap-1 pr-1"
      data-testid={`files-mobile-folder-${folder.id}`}
    >
      <button
        type="button"
        onClick={open}
        aria-label={t("folders.open", { name: folder.name })}
        className="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 active:bg-muted/50"
        data-testid={`files-mobile-folder-open-${folder.id}`}
      >
        <span className="flex size-10 shrink-0 items-center justify-center">
          <FilesFolderGlyph folder={folder} className="size-6" />
        </span>
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium">{folder.name}</span>
            <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground tabular-nums">
              {relativeCompact(Math.min(folder.updatedAt, now), now, locale)}
            </span>
          </span>
          <span className="block text-[11px] text-muted-foreground">
            {t("folders.itemCount", { count: itemCount })}
          </span>
        </span>
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            aria-label={t("folders.menu", { name: folder.name })}
            data-testid={`files-folder-item-menu-${folder.id}`}
          >
            <MoreHorizontalIcon className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <FilesMenuNodes nodes={nodes} kind="dropdown" testIdPrefix="files-folder-action" />
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}
