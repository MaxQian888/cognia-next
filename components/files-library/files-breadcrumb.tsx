"use client"

/**
 * Where the Files view is (ADR-0223): the place's name, and inside a folder
 * the path back up to "All folders" with the current folder's menu beside it.
 * The header uses `useFilesPlaceTitle` for its title; the breadcrumb renders
 * only inside a folder.
 */

import { useTranslations } from "next-intl"
import { ChevronRightIcon, LayoutGridIcon, MoreHorizontalIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import { ROOT_LIBRARY_FOLDER_ID, type LibraryFolder } from "@/lib/db/files-library-types"
import { libraryFolderPath } from "@/lib/files-library/folder-tree"
import type { FilesSection } from "@/lib/files-library/types"
import { cn } from "@/lib/utils"
import { useFilesLibraryStore } from "@/stores/files-library"

import { FilesFolderGlyph } from "./files-folder-glyph"
import { useFilesFolderMenu } from "./files-folder-menu"
import { FilesMenuNodes } from "./files-menu"

/** The header title for a place. */
export function useFilesPlaceTitle(folders: readonly LibraryFolder[]): string {
  const t = useTranslations("files")
  const section = useFilesLibraryStore((s) => s.section)
  return placeTitle(section, folders, t)
}

export function placeTitle(
  section: FilesSection,
  folders: readonly LibraryFolder[],
  t: (key: string) => string
): string {
  switch (section.kind) {
    case "all":
      return t("places.all")
    case "group":
      return t(`places.groups.${section.group}`)
    case "recent":
      return t("places.recents")
    case "trash":
      return t("places.trash")
    case "folder":
      if (section.folderId === ROOT_LIBRARY_FOLDER_ID) return t("folders.root")
      return folders.find((folder) => folder.id === section.folderId)?.name ?? t("folders.root")
  }
}

function CurrentFolderMenu({
  folder,
  actions,
}: {
  folder: LibraryFolder
  actions: Pick<FilesActions, "setFolderStyle">
}) {
  const t = useTranslations("files")
  const nodes = useFilesFolderMenu(folder, actions)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={t("folders.menu", { name: folder.name })}
          data-testid="files-breadcrumb-menu"
        >
          <MoreHorizontalIcon className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <FilesMenuNodes nodes={nodes} kind="dropdown" testIdPrefix="files-folder-action" />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function FilesBreadcrumb({
  folders,
  actions,
}: {
  folders: readonly LibraryFolder[]
  actions: Pick<FilesActions, "setFolderStyle">
}) {
  const t = useTranslations("files")
  const section = useFilesLibraryStore((s) => s.section)
  const setSection = useFilesLibraryStore((s) => s.setSection)
  if (section.kind !== "folder") return null
  const path = libraryFolderPath(folders, section.folderId)
  const current = path.at(-1)

  return (
    <nav
      aria-label={t("folders.breadcrumbAria")}
      className="flex min-w-0 items-center gap-1 overflow-x-auto text-sm text-muted-foreground"
      data-testid="files-breadcrumb"
    >
      <button
        type="button"
        onClick={() => setSection({ kind: "folder", folderId: ROOT_LIBRARY_FOLDER_ID })}
        aria-current={path.length === 0 ? "page" : undefined}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 whitespace-nowrap hover:text-foreground",
          path.length === 0 && "font-medium text-foreground"
        )}
        data-testid="files-breadcrumb-root"
      >
        <LayoutGridIcon className="size-3.5" aria-hidden />
        {t("folders.root")}
      </button>
      {path.map((folder, index) => {
        const last = index === path.length - 1
        return (
          <span key={folder.id} className="flex min-w-0 shrink-0 items-center gap-1">
            <ChevronRightIcon className="size-3.5 shrink-0" aria-hidden />
            <button
              type="button"
              onClick={() => setSection({ kind: "folder", folderId: folder.id })}
              aria-current={last ? "page" : undefined}
              className={cn(
                "inline-flex max-w-[12rem] items-center gap-1 rounded px-1 py-0.5 hover:text-foreground",
                last && "font-medium text-foreground"
              )}
              data-testid={`files-breadcrumb-${folder.id}`}
            >
              <FilesFolderGlyph folder={folder} className="size-3.5" />
              <span className="truncate">{folder.name}</span>
            </button>
          </span>
        )
      })}
      {current ? <CurrentFolderMenu folder={current} actions={actions} /> : null}
    </nav>
  )
}
