"use client"

/**
 * A folder's actions (ADR-0223): new subfolder, rename, color, icon, delete.
 * One model for the sidebar tree's right-click menu, its "⋯" button and the
 * folder view's own menu (`FilesMenuNodes`).
 */

import { useTranslations } from "next-intl"
import { FolderPlusIcon, PaletteIcon, PencilIcon, ShapesIcon, Trash2Icon } from "lucide-react"

import {
  LIBRARY_FOLDER_COLORS,
  LIBRARY_FOLDER_ICONS,
  type LibraryFolder,
} from "@/lib/db/files-library-types"
import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import { cn } from "@/lib/utils"
import { useFilesLibraryStore } from "@/stores/files-library"

import { FOLDER_ICON_GLYPHS, FOLDER_SWATCH_CLASSES } from "./files-folder-glyph"
import type { FilesMenuNode } from "./files-menu"

export function useFilesFolderMenu(
  folder: LibraryFolder,
  actions: Pick<FilesActions, "setFolderStyle">
): FilesMenuNode[] {
  const t = useTranslations("files")
  const openFolderDialog = useFilesLibraryStore((s) => s.openFolderDialog)
  const openDeleteFolder = useFilesLibraryStore((s) => s.openDeleteFolder)
  const setFolderExpanded = useFilesLibraryStore((s) => s.setFolderExpanded)

  return [
    {
      type: "item",
      id: "new-subfolder",
      label: t("folders.newSubfolder"),
      icon: FolderPlusIcon,
      onSelect: () => {
        setFolderExpanded(folder.id, true)
        openFolderDialog({ mode: "create", parentId: folder.id })
      },
    },
    {
      type: "item",
      id: "rename",
      label: t("folders.rename"),
      icon: PencilIcon,
      onSelect: () => openFolderDialog({ mode: "rename", folderId: folder.id, name: folder.name }),
    },
    {
      type: "submenu",
      id: "color",
      label: t("folders.color"),
      icon: PaletteIcon,
      children: [
        {
          type: "item",
          id: "color-default",
          label: t("folders.colors.default"),
          current: folder.color === undefined,
          leading: <span className="size-3 rounded-full border bg-primary" aria-hidden />,
          onSelect: () => void actions.setFolderStyle(folder.id, { color: null }),
        },
        ...LIBRARY_FOLDER_COLORS.map((color): FilesMenuNode => ({
          type: "item",
          id: `color-${color}`,
          label: t(`folders.colors.${color}`),
          current: folder.color === color,
          leading: (
            <span className={cn("size-3 rounded-full", FOLDER_SWATCH_CLASSES[color])} aria-hidden />
          ),
          onSelect: () => void actions.setFolderStyle(folder.id, { color }),
        })),
      ],
    },
    {
      type: "submenu",
      id: "icon",
      label: t("folders.icon"),
      icon: ShapesIcon,
      children: LIBRARY_FOLDER_ICONS.map((icon): FilesMenuNode => ({
        type: "item",
        id: `icon-${icon}`,
        label: t(`folders.icons.${icon}`),
        icon: FOLDER_ICON_GLYPHS[icon],
        current: (folder.icon ?? "folder") === icon,
        onSelect: () =>
          void actions.setFolderStyle(folder.id, { icon: icon === "folder" ? null : icon }),
      })),
    },
    { type: "separator", id: "sep-delete" },
    {
      type: "item",
      id: "delete",
      label: t("folders.delete"),
      icon: Trash2Icon,
      destructive: true,
      onSelect: () => openDeleteFolder(folder.id),
    },
  ]
}
