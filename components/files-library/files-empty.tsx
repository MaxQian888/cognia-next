"use client"

/**
 * What an empty Files view says (ADR-0223). A search or filter that hid
 * everything offers to clear it; the Trash, a lens and each kind of place
 * explain what would appear there.
 */

import { useTranslations } from "next-intl"
import {
  BotIcon,
  ClockIcon,
  FolderOpenIcon,
  SearchXIcon,
  StarIcon,
  Trash2Icon,
  UserIcon,
  Users2Icon,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import type { FilesLens, FilesSection } from "@/lib/files-library/types"

export type FilesEmptyCopy =
  | "search"
  | "trash"
  | "favorites"
  | "mine"
  | "ai"
  | "shared"
  | "recent"
  | "folder"
  | "group"
  | "all"

const ICONS: Record<FilesEmptyCopy, LucideIcon> = {
  search: SearchXIcon,
  trash: Trash2Icon,
  favorites: StarIcon,
  mine: UserIcon,
  ai: BotIcon,
  shared: Users2Icon,
  recent: ClockIcon,
  folder: FolderOpenIcon,
  group: FolderOpenIcon,
  all: FolderOpenIcon,
}

/** Which copy an empty view gets: filters first, then the Trash, a lens, the place. */
export function filesEmptyCopy(
  section: FilesSection,
  lens: FilesLens,
  filtered: boolean
): FilesEmptyCopy {
  if (filtered) return "search"
  if (section.kind === "trash") return "trash"
  if (lens !== "suggested") return lens
  return section.kind
}

export function FilesEmpty({
  section,
  lens,
  filtered,
  onClear,
  touch = false,
}: {
  section: FilesSection
  lens: FilesLens
  filtered: boolean
  onClear: () => void
  /** The phone layout: nothing drags there, so an empty folder says how to fill it by tap. */
  touch?: boolean
}) {
  const t = useTranslations("files.empty")
  const copy = filesEmptyCopy(section, lens, filtered)
  const Icon = ICONS[copy]
  return (
    <Empty className="border-0 py-16" data-testid={`files-empty-${copy}`}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{t(`${copy}.title`)}</EmptyTitle>
        <EmptyDescription>
          {touch && copy === "folder" ? t("folder.descriptionTouch") : t(`${copy}.description`)}
        </EmptyDescription>
      </EmptyHeader>
      {filtered ? (
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={onClear} data-testid="files-empty-clear">
            {t("clear")}
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  )
}
