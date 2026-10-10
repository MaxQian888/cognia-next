"use client"

/**
 * A folder's icon in the color and glyph the person picked (ADR-0223), drawn
 * the same in the sidebar tree, the folder view and the move dialog. The icon
 * is decorative: the folder's name beside it is the accessible name.
 */

import {
  ArchiveIcon,
  BookOpenIcon,
  BriefcaseIcon,
  CodeIcon,
  FlagIcon,
  FolderIcon,
  FolderOpenIcon,
  HeartIcon,
  ImageIcon,
  MusicIcon,
  StarIcon,
  type LucideIcon,
} from "lucide-react"

import type {
  LibraryFolder,
  LibraryFolderColor,
  LibraryFolderIcon,
} from "@/lib/db/files-library-types"
import { cn } from "@/lib/utils"

export const FOLDER_ICON_GLYPHS: Record<LibraryFolderIcon, LucideIcon> = {
  folder: FolderIcon,
  star: StarIcon,
  briefcase: BriefcaseIcon,
  book: BookOpenIcon,
  code: CodeIcon,
  image: ImageIcon,
  music: MusicIcon,
  archive: ArchiveIcon,
  heart: HeartIcon,
  flag: FlagIcon,
}

/** Text colors that read on both themes. */
export const FOLDER_COLOR_CLASSES: Record<LibraryFolderColor, string> = {
  gray: "text-muted-foreground",
  red: "text-red-500",
  orange: "text-orange-500",
  amber: "text-amber-500",
  green: "text-emerald-500",
  teal: "text-teal-500",
  blue: "text-blue-500",
  violet: "text-violet-500",
  pink: "text-pink-500",
}

/** Swatch fills for the color picker. */
export const FOLDER_SWATCH_CLASSES: Record<LibraryFolderColor, string> = {
  gray: "bg-muted-foreground",
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  green: "bg-emerald-500",
  teal: "bg-teal-500",
  blue: "bg-blue-500",
  violet: "bg-violet-500",
  pink: "bg-pink-500",
}

export function FilesFolderGlyph({
  folder,
  open = false,
  className,
}: {
  folder: Pick<LibraryFolder, "color" | "icon">
  /** A plain folder shows as open while it is expanded or in view. */
  open?: boolean
  className?: string
}) {
  const Glyph =
    folder.icon && folder.icon !== "folder"
      ? FOLDER_ICON_GLYPHS[folder.icon]
      : open
        ? FolderOpenIcon
        : FolderIcon
  return (
    <Glyph
      className={cn(
        "size-4 shrink-0",
        folder.color ? FOLDER_COLOR_CLASSES[folder.color] : "text-primary",
        className
      )}
      aria-hidden
      data-testid="files-folder-glyph"
      data-color={folder.color ?? "default"}
      data-icon={folder.icon ?? "folder"}
    />
  )
}
