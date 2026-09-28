"use client"

import { useTranslations } from "next-intl"
import { FolderOpenIcon, ImageIcon, SearchXIcon, StarIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import type { FilesTab } from "@/lib/files-library/types"

const ICONS = {
  recent: FolderOpenIcon,
  favorites: StarIcon,
  folders: FolderOpenIcon,
  images: ImageIcon,
  all: FolderOpenIcon,
} as const

/** Per-tab empty state; `filtered` when a search or filter hid everything. */
export function FilesEmpty({
  tab,
  filtered,
  onClear,
}: {
  tab: FilesTab
  filtered: boolean
  onClear: () => void
}) {
  const t = useTranslations("files.empty")
  const Icon = filtered ? SearchXIcon : ICONS[tab]
  const copy = filtered ? "search" : tab
  return (
    <Empty className="border-0 py-16" data-testid={`files-empty-${filtered ? "filtered" : tab}`}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{t(`${copy}.title`)}</EmptyTitle>
        <EmptyDescription>{t(`${copy}.description`)}</EmptyDescription>
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
