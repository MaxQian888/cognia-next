"use client"

/**
 * The sidebar's folder tree (ADR-0223): nested folders that open and close
 * (remembered per device), each a place to go, a target to drop items or
 * folders on, and a folder to drag. Right-click or "⋯" opens the folder's
 * menu.
 */

import { useTranslations } from "next-intl"
import { ChevronRightIcon, MoreHorizontalIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import { childLibraryFolders } from "@/lib/files-library/folder-tree"
import { HOVER_REVEAL_CONTROL_CLASS } from "@/lib/ui/hover-reveal"
import { cn } from "@/lib/utils"
import { useFilesLibraryStore } from "@/stores/files-library"

import { useFilesFolderDrag, useFilesFolderDrop } from "./files-dnd"
import { FilesFolderGlyph } from "./files-folder-glyph"
import { useFilesFolderMenu } from "./files-folder-menu"
import { FilesMenuNodes } from "./files-menu"

/** Guard against a corrupt parent cycle when rendering. */
const MAX_DEPTH = 32

export interface FilesFolderTreeProps {
  folders: readonly LibraryFolder[]
  parentId: string
  depth?: number
  actions: Pick<FilesActions, "setFolderStyle">
}

export function FilesFolderTree({ folders, parentId, depth = 0, actions }: FilesFolderTreeProps) {
  if (depth >= MAX_DEPTH) return null
  const children = childLibraryFolders(folders, parentId)
  if (children.length === 0) return null
  return (
    <ul role={depth === 0 ? "tree" : "group"} className="flex flex-col">
      {children.map((folder) => (
        <FilesFolderTreeNode
          key={folder.id}
          folder={folder}
          folders={folders}
          depth={depth}
          actions={actions}
        />
      ))}
    </ul>
  )
}

function FilesFolderTreeNode({
  folder,
  folders,
  depth,
  actions,
}: {
  folder: LibraryFolder
  folders: readonly LibraryFolder[]
  depth: number
  actions: Pick<FilesActions, "setFolderStyle">
}) {
  const t = useTranslations("files")
  const section = useFilesLibraryStore((s) => s.section)
  const setSection = useFilesLibraryStore((s) => s.setSection)
  const expanded = useFilesLibraryStore((s) => s.expandedFolderIds.includes(folder.id))
  const setFolderExpanded = useFilesLibraryStore((s) => s.setFolderExpanded)
  const menu = useFilesFolderMenu(folder, actions)
  const drop = useFilesFolderDrop(folder.id)
  const drag = useFilesFolderDrag(folder.id)
  const hasChildren = folders.some((candidate) => candidate.parentFolderId === folder.id)
  const current = section.kind === "folder" && section.folderId === folder.id

  return (
    <li role="treeitem" aria-expanded={hasChildren ? expanded : undefined} aria-selected={current}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={(node) => {
              drop.setNodeRef(node)
              drag.setNodeRef(node)
            }}
            {...drag.attributes}
            {...drag.listeners}
            // dnd-kit's attributes claim a button role; the row's own button is
            // the control, the wrapper is only the drag handle.
            role={undefined}
            tabIndex={-1}
            className={cn(
              "group flex h-8 min-w-0 items-center gap-1 rounded-md pr-1 text-sm hover:bg-accent/60",
              current && "bg-accent font-medium",
              drop.isOver && "ring-2 ring-primary/60",
              drag.isDragging && "opacity-50"
            )}
            style={{ paddingLeft: `${depth * 12 + 4}px` }}
            data-testid={`files-tree-folder-${folder.id}`}
            data-drop-over={drop.isOver || undefined}
          >
            <button
              type="button"
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground",
                !hasChildren && "invisible"
              )}
              aria-label={t(expanded ? "folders.collapse" : "folders.expand", {
                name: folder.name,
              })}
              tabIndex={hasChildren ? 0 : -1}
              onClick={() => setFolderExpanded(folder.id, !expanded)}
              data-testid={`files-tree-toggle-${folder.id}`}
            >
              <ChevronRightIcon
                className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
                aria-hidden
              />
            </button>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              aria-current={current ? "page" : undefined}
              onClick={() => setSection({ kind: "folder", folderId: folder.id })}
              data-testid={`files-tree-open-${folder.id}`}
            >
              <FilesFolderGlyph folder={folder} open={current || expanded} />
              <span className="truncate">{folder.name}</span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    HOVER_REVEAL_CONTROL_CLASS,
                    "size-6 group-focus-within:opacity-100"
                  )}
                  aria-label={t("folders.menu", { name: folder.name })}
                  data-testid={`files-tree-menu-${folder.id}`}
                >
                  <MoreHorizontalIcon className="size-3.5" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <FilesMenuNodes nodes={menu} kind="dropdown" testIdPrefix="files-folder-action" />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <FilesMenuNodes nodes={menu} kind="context" testIdPrefix="files-folder-context" />
        </ContextMenuContent>
      </ContextMenu>
      {expanded ? (
        <FilesFolderTree
          folders={folders}
          parentId={folder.id}
          depth={depth + 1}
          actions={actions}
        />
      ) : null}
    </li>
  )
}
