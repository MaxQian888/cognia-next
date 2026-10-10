"use client"

/**
 * The Files sidebar (ADR-0223): the places — All, the type groups, Recents,
 * the folder tree and the Trash. Folders and the Trash accept drops; Recents
 * lists the newest few and "Show more" opens the Recents place.
 */

import type { ComponentType } from "react"
import { useTranslations } from "next-intl"
import {
  ClockIcon,
  FileIcon,
  FilmIcon,
  FolderPlusIcon,
  ImageIcon,
  LayoutGridIcon,
  PenLineIcon,
  ShapesIcon,
  Trash2Icon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { displayTitle, type FilesActions } from "@/hooks/files-library/use-files-actions"
import { ROOT_LIBRARY_FOLDER_ID, type LibraryFolder } from "@/lib/db/files-library-types"
import { sameFilesSection } from "@/lib/files-library/deep-link"
import {
  FILES_TYPE_GROUPS,
  type FilesEntry,
  type FilesSection,
  type FilesTypeGroup,
} from "@/lib/files-library/types"
import { cn } from "@/lib/utils"
import { useFilesLibraryStore } from "@/stores/files-library"

import { useFilesFolderDrop, useFilesTrashDrop } from "./files-dnd"
import { FilesEntryIcon } from "./files-entry-icon"
import { FilesFolderTree } from "./files-folder-tree"

const GROUP_ICONS: Record<FilesTypeGroup, ComponentType<{ className?: string }>> = {
  documents: PenLineIcon,
  artifacts: ShapesIcon,
  images: ImageIcon,
  videos: FilmIcon,
  uploads: FileIcon,
}

export interface FilesSidebarProps {
  folders: readonly LibraryFolder[]
  recents: readonly FilesEntry[]
  trashCount: number
  actions: Pick<FilesActions, "preview" | "setFolderStyle">
}

function PlaceButton({
  section,
  icon: Icon,
  label,
  testId,
  trailing,
}: {
  section: FilesSection
  icon: ComponentType<{ className?: string }>
  label: string
  testId: string
  trailing?: React.ReactNode
}) {
  const current = useFilesLibraryStore((s) => sameFilesSection(s.section, section))
  const setSection = useFilesLibraryStore((s) => s.setSection)
  return (
    <button
      type="button"
      onClick={() => setSection(section)}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60",
        current && "bg-accent font-medium"
      )}
      data-testid={testId}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{label}</span>
      {trailing}
    </button>
  )
}

function SectionLabel({
  children,
  action,
}: {
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex h-7 items-center justify-between px-2 pt-3 text-xs font-medium text-muted-foreground">
      <span>{children}</span>
      {action}
    </div>
  )
}

function FoldersRoot() {
  const t = useTranslations("files")
  const { setNodeRef, isOver } = useFilesFolderDrop(ROOT_LIBRARY_FOLDER_ID)
  return (
    <div
      ref={setNodeRef}
      className={cn("rounded-md", isOver && "ring-2 ring-primary/60")}
      data-testid="files-tree-root"
      data-drop-over={isOver || undefined}
    >
      <PlaceButton
        section={{ kind: "folder", folderId: ROOT_LIBRARY_FOLDER_ID }}
        icon={LayoutGridIcon}
        label={t("folders.root")}
        testId="files-place-folders"
      />
    </div>
  )
}

function TrashPlace({ count }: { count: number }) {
  const t = useTranslations("files")
  const { setNodeRef, isOver } = useFilesTrashDrop()
  return (
    <div
      ref={setNodeRef}
      className={cn("rounded-md", isOver && "ring-2 ring-destructive/60")}
      data-testid="files-trash-drop"
      data-drop-over={isOver || undefined}
    >
      <PlaceButton
        section={{ kind: "trash" }}
        icon={Trash2Icon}
        label={t("places.trash")}
        testId="files-place-trash"
        trailing={
          count > 0 ? (
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">{count}</span>
          ) : null
        }
      />
    </div>
  )
}

export function FilesSidebar({ folders, recents, trashCount, actions }: FilesSidebarProps) {
  const t = useTranslations("files")
  const setSection = useFilesLibraryStore((s) => s.setSection)
  const openFolderDialog = useFilesLibraryStore((s) => s.openFolderDialog)

  return (
    <nav
      aria-label={t("sidebar.aria")}
      className="flex h-full min-h-0 flex-col"
      data-testid="files-sidebar"
    >
      <div className="flex h-12 shrink-0 items-center px-4 text-base font-semibold">
        {t("title")}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
        <PlaceButton
          section={{ kind: "all" }}
          icon={LayoutGridIcon}
          label={t("places.all")}
          testId="files-place-all"
        />
        {FILES_TYPE_GROUPS.map((group) => (
          <PlaceButton
            key={group}
            section={{ kind: "group", group }}
            icon={GROUP_ICONS[group]}
            label={t(`places.groups.${group}`)}
            testId={`files-place-group-${group}`}
          />
        ))}

        <SectionLabel>{t("places.recents")}</SectionLabel>
        {recents.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">{t("sidebar.noRecents")}</p>
        ) : (
          <ul className="flex flex-col" aria-label={t("places.recents")}>
            {recents.map((entry) => {
              const title = displayTitle(entry, t)
              return (
                <li key={entry.key}>
                  <button
                    type="button"
                    onClick={() => actions.preview(entry)}
                    className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60"
                    aria-label={t("card.open", { title })}
                    data-testid={`files-recent-${entry.key}`}
                  >
                    <FilesEntryIcon entry={entry} className="size-4" />
                    <span className="truncate">{title}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <button
          type="button"
          onClick={() => setSection({ kind: "recent" })}
          className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          data-testid="files-recents-more"
        >
          <ClockIcon className="size-3.5" aria-hidden />
          {t("sidebar.showMore")}
        </button>

        <SectionLabel
          action={
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label={t("folders.newFolder")}
              onClick={() => openFolderDialog({ mode: "create", parentId: ROOT_LIBRARY_FOLDER_ID })}
              data-testid="files-sidebar-new-folder"
            >
              <FolderPlusIcon className="size-3.5" aria-hidden />
            </Button>
          }
        >
          {t("places.folders")}
        </SectionLabel>
        <FoldersRoot />
        <FilesFolderTree folders={folders} parentId={ROOT_LIBRARY_FOLDER_ID} actions={actions} />
      </div>
      <div className="shrink-0 border-t px-2 py-2">
        <TrashPlace count={trashCount} />
      </div>
    </nav>
  )
}
