"use client"

import { useTranslations } from "next-intl"
import {
  DownloadIcon,
  EyeIcon,
  FolderInputIcon,
  FolderMinusIcon,
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
  SquareArrowOutUpRightIcon,
  StarIcon,
  StarOffIcon,
  Trash2Icon,
  XCircleIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

export interface FilesItemMenuProps {
  entry: FilesEntry
  title: string
  actions: FilesActions
  className?: string
}

export function FilesItemMenu({ entry, title, actions, className }: FilesItemMenuProps) {
  const t = useTranslations("files")
  const openMove = useFilesLibraryStore((s) => s.openMove)
  const openDelete = useFilesLibraryStore((s) => s.openDelete)
  const favorite = entry.favoritedAt !== undefined

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={className}
          aria-label={t("card.menu", { title })}
          data-testid={`files-item-menu-${entry.key}`}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontalIcon className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem onSelect={() => void actions.open(entry)} data-testid="files-action-open">
          <SquareArrowOutUpRightIcon aria-hidden />
          {t("actions.open")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => actions.preview(entry)}
          data-testid="files-action-preview"
        >
          <EyeIcon aria-hidden />
          {t("actions.preview")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => void actions.useInChat(entry)}
          data-testid="files-action-use-in-chat"
        >
          <MessageSquarePlusIcon aria-hidden />
          {t("actions.useInChat")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void actions.toggleFavorite(entry)}
          data-testid="files-action-favorite"
        >
          {favorite ? <StarOffIcon aria-hidden /> : <StarIcon aria-hidden />}
          {favorite ? t("actions.unfavorite") : t("actions.favorite")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openMove([entry.key])} data-testid="files-action-move">
          <FolderInputIcon aria-hidden />
          {t("actions.moveToFolder")}
        </DropdownMenuItem>
        {entry.folderId !== undefined ? (
          <DropdownMenuItem
            onSelect={() => void actions.moveToFolder([entry], null)}
            data-testid="files-action-unfile"
          >
            <FolderMinusIcon aria-hidden />
            {t("actions.removeFromFolder")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={() => void actions.download(entry)}
          data-testid="files-action-download"
        >
          <DownloadIcon aria-hidden />
          {t("actions.download")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {entry.ownedByFiles ? (
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => openDelete(entry.key)}
            data-testid="files-action-delete"
          >
            <Trash2Icon aria-hidden />
            {t("actions.delete")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onSelect={() => void actions.remove(entry)}
            data-testid="files-action-remove"
          >
            <XCircleIcon aria-hidden />
            {t("actions.remove")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
