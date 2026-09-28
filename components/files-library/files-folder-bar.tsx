"use client"

/**
 * The Folders tab's navigation: a breadcrumb back to the root, the current
 * folder's subfolders as tiles, and rename / delete for the folder in view.
 */

import { useTranslations } from "next-intl"
import {
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  HomeIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ROOT_LIBRARY_FOLDER_ID, type LibraryFolder } from "@/lib/db/files-library-types"
import { childLibraryFolders, libraryFolderPath } from "@/lib/files-library/folder-tree"
import { cn } from "@/lib/utils"
import { useFilesLibraryStore } from "@/stores/files-library"

export function FilesFolderBar({ folders }: { folders: readonly LibraryFolder[] }) {
  const t = useTranslations("files")
  const folderId = useFilesLibraryStore((s) => s.folderId)
  const enterFolder = useFilesLibraryStore((s) => s.enterFolder)
  const openFolderDialog = useFilesLibraryStore((s) => s.openFolderDialog)
  const openDeleteFolder = useFilesLibraryStore((s) => s.openDeleteFolder)
  const path = libraryFolderPath(folders, folderId)
  const current = path.at(-1)
  const children = childLibraryFolders(folders, folderId)

  return (
    <div className="flex flex-col gap-3 px-4 pt-4" data-testid="files-folder-bar">
      <div className="flex items-center gap-2">
        <nav
          aria-label={t("folders.breadcrumbAria")}
          className="flex min-w-0 flex-1 items-center gap-1 text-sm text-muted-foreground"
        >
          <button
            type="button"
            onClick={() => enterFolder(ROOT_LIBRARY_FOLDER_ID)}
            className={cn(
              "inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground",
              folderId === ROOT_LIBRARY_FOLDER_ID && "font-medium text-foreground"
            )}
            data-testid="files-breadcrumb-root"
          >
            <HomeIcon className="size-3.5" aria-hidden />
            {t("folders.root")}
          </button>
          {path.map((folder, index) => (
            <span key={folder.id} className="flex min-w-0 items-center gap-1">
              <ChevronRightIcon className="size-3.5 shrink-0" aria-hidden />
              <button
                type="button"
                onClick={() => enterFolder(folder.id)}
                aria-current={index === path.length - 1 ? "page" : undefined}
                className={cn(
                  "max-w-[12rem] truncate rounded px-1 py-0.5 hover:text-foreground",
                  index === path.length - 1 && "font-medium text-foreground"
                )}
                data-testid={`files-breadcrumb-${folder.id}`}
              >
                {folder.name}
              </button>
            </span>
          ))}
        </nav>
        <Button
          variant="outline"
          size="sm"
          onClick={() => openFolderDialog({ mode: "create", parentId: folderId })}
          data-testid="files-folder-create"
        >
          <FolderPlusIcon aria-hidden />
          {t("folders.newFolder")}
        </Button>
        {current ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={t("folders.menu", { name: current.name })}
                data-testid="files-folder-menu"
              >
                <MoreHorizontalIcon className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() =>
                  openFolderDialog({ mode: "rename", folderId: current.id, name: current.name })
                }
                data-testid="files-folder-rename"
              >
                <PencilIcon aria-hidden />
                {t("folders.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => openDeleteFolder(current.id)}
                data-testid="files-folder-delete"
              >
                <Trash2Icon aria-hidden />
                {t("folders.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {children.length > 0 ? (
        <ul
          aria-label={t("folders.subfolders")}
          className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2"
        >
          {children.map((folder) => (
            <li key={folder.id}>
              <button
                type="button"
                onClick={() => enterFolder(folder.id)}
                aria-label={t("folders.open", { name: folder.name })}
                className="flex w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left text-sm hover:bg-accent/50"
                data-testid={`files-folder-${folder.id}`}
              >
                <FolderIcon className="size-4 shrink-0 text-primary" aria-hidden />
                <span className="truncate">{folder.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
