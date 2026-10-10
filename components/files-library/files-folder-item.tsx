"use client"

/**
 * A subfolder inside the folder in view (ADR-0223): a tile in the grid, a row
 * in the list. Opening it (click, Enter) moves the view into it; it accepts
 * dropped items and folders, can itself be dragged, and right-click or "⋯"
 * opens the same folder menu as the sidebar tree.
 */

import type { ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import { MoreHorizontalIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TableCell, TableRow } from "@/components/ui/table"
import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import { relativeCompact } from "@/lib/notifications/functional-toast/relative-time"
import { HOVER_REVEAL_CONTROL_CLASS } from "@/lib/ui/hover-reveal"
import { cn } from "@/lib/utils"
import { useFilesLibraryStore } from "@/stores/files-library"

import { useFilesFolderDrag, useFilesFolderDrop } from "./files-dnd"
import { FilesFolderGlyph } from "./files-folder-glyph"
import { useFilesFolderMenu } from "./files-folder-menu"
import { FilesMenuNodes } from "./files-menu"

export interface FilesFolderItemProps {
  folder: LibraryFolder
  /** Items filed directly in the folder (what the view shows inside it). */
  itemCount: number
  actions: Pick<FilesActions, "setFolderStyle">
  now: number
}

function useFolderItem(folder: LibraryFolder, actions: Pick<FilesActions, "setFolderStyle">) {
  const setSection = useFilesLibraryStore((s) => s.setSection)
  const setFolderExpanded = useFilesLibraryStore((s) => s.setFolderExpanded)
  const menu = useFilesFolderMenu(folder, actions)
  const drop = useFilesFolderDrop(folder.id)
  const drag = useFilesFolderDrag(folder.id)
  const open = () => {
    setFolderExpanded(folder.id, true)
    setSection({ kind: "folder", folderId: folder.id })
  }
  return { menu, drop, drag, open }
}

function FolderMenuButton({
  folder,
  nodes,
  className,
}: {
  folder: LibraryFolder
  nodes: ReturnType<typeof useFilesFolderMenu>
  className?: string
}) {
  const t = useTranslations("files")
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            HOVER_REVEAL_CONTROL_CLASS,
            "size-7 group-focus-within:opacity-100",
            className
          )}
          aria-label={t("folders.menu", { name: folder.name })}
          data-testid={`files-folder-item-menu-${folder.id}`}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontalIcon className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <FilesMenuNodes nodes={nodes} kind="dropdown" testIdPrefix="files-folder-action" />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function WithContextMenu({
  nodes,
  children,
}: {
  nodes: ReturnType<typeof useFilesFolderMenu>
  children: ReactNode
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <FilesMenuNodes nodes={nodes} kind="context" testIdPrefix="files-folder-context" />
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** The grid's folder tile. */
export function FilesFolderTile({ folder, itemCount, actions }: FilesFolderItemProps) {
  const t = useTranslations("files")
  const { menu, drop, drag, open } = useFolderItem(folder, actions)
  return (
    <WithContextMenu nodes={menu}>
      <div
        ref={(node) => {
          drop.setNodeRef(node)
          drag.setNodeRef(node)
        }}
        {...drag.attributes}
        {...drag.listeners}
        role="button"
        tabIndex={0}
        aria-label={t("folders.open", { name: folder.name })}
        onClick={open}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            open()
          }
        }}
        className={cn(
          "group relative flex min-w-0 cursor-pointer items-center gap-3 rounded-xl border bg-card px-4 py-3 text-left text-sm transition-colors outline-none hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
          drop.isOver && "ring-2 ring-primary/60",
          drag.isDragging && "opacity-50"
        )}
        data-testid={`files-folder-tile-${folder.id}`}
        data-drop-over={drop.isOver || undefined}
      >
        <FilesFolderGlyph folder={folder} className="size-5" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{folder.name}</p>
          <p className="text-xs text-muted-foreground">
            {t("folders.itemCount", { count: itemCount })}
          </p>
        </div>
        <FolderMenuButton folder={folder} nodes={menu} />
      </div>
    </WithContextMenu>
  )
}

/** The list's folder row; it spans the item columns it has nothing for. */
export function FilesFolderRow({ folder, itemCount, actions, now }: FilesFolderItemProps) {
  const t = useTranslations("files")
  const locale = useLocale()
  const { menu, drop, drag, open } = useFolderItem(folder, actions)
  return (
    <WithContextMenu nodes={menu}>
      <TableRow
        ref={(node) => {
          drop.setNodeRef(node)
          drag.setNodeRef(node)
        }}
        {...drag.attributes}
        {...drag.listeners}
        role="row"
        tabIndex={0}
        aria-label={t("folders.open", { name: folder.name })}
        onClick={open}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
          if (event.key === "Enter") {
            event.preventDefault()
            open()
          }
        }}
        className={cn(
          "group cursor-pointer outline-none focus-visible:bg-accent/40",
          drop.isOver && "bg-primary/10",
          drag.isDragging && "opacity-50"
        )}
        data-testid={`files-folder-row-${folder.id}`}
        data-drop-over={drop.isOver || undefined}
      >
        <TableCell className="w-10 pr-0" />
        <TableCell className="min-w-0">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center">
              <FilesFolderGlyph folder={folder} className="size-5" />
            </div>
            <span className="min-w-0 truncate font-medium">{folder.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {t("folders.itemCount", { count: itemCount })}
            </span>
          </div>
        </TableCell>
        <TableCell className="hidden @xl/files:table-cell" />
        <TableCell
          className="w-28 text-muted-foreground tabular-nums"
          title={new Date(folder.updatedAt).toLocaleString(locale)}
        >
          {relativeCompact(Math.min(folder.updatedAt, now), now, locale)}
        </TableCell>
        <TableCell className="hidden @2xl/files:table-cell" />
        <TableCell className="hidden text-muted-foreground @3xl/files:table-cell">
          {t("formats.folder")}
        </TableCell>
        <TableCell className="w-10 px-1" onClick={(event) => event.stopPropagation()}>
          <FolderMenuButton folder={folder} nodes={menu} />
        </TableCell>
      </TableRow>
    </WithContextMenu>
  )
}
