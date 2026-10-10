"use client"

/**
 * A Files item's actions (ADR-0223), as one model rendered twice: the "⋯"
 * dropdown on a card or row, and the right-click menu around it.
 *
 * - In the Trash an item offers Preview, Restore and Delete forever.
 * - Everywhere else: open, preview, use in chat; favorite, move, take out of
 *   a folder; rename, duplicate, save as template (documents, while the
 *   template platform is on), download; share as a link (ADR-0222's file
 *   bundle, `files-share-dialog.tsx`); and Move to Trash, which replaced both
 *   "Remove from Files" and "Delete".
 *
 * What the library holds back here (a paired device: sharing, and saving a
 * template) stays listed, disabled, with where to do it instead (ADR-0223 §9).
 */

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  FolderInputIcon,
  FolderMinusIcon,
  LayoutTemplateIcon,
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RotateCcwIcon,
  Share2Icon,
  SquareArrowOutUpRightIcon,
  StarIcon,
  StarOffIcon,
  Trash2Icon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useFilesOps } from "@/hooks/files-library/files-backend"
import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import { hasDocumentDraft } from "@/lib/files-library/document-draft"
import { isFilesShareAvailable } from "@/lib/files-library/share"
import { isUnifiedTemplatePlatformEnabled } from "@/lib/templates/feature-flags"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

import { FilesMenuNodes, type FilesMenuNode } from "./files-menu"

export function useFilesItemMenu(entry: FilesEntry, actions: FilesActions): FilesMenuNode[] {
  const t = useTranslations("files")
  const openMove = useFilesLibraryStore((s) => s.openMove)
  const openRename = useFilesLibraryStore((s) => s.openRename)
  const openDeleteForever = useFilesLibraryStore((s) => s.openDeleteForever)
  const openSaveTemplate = useFilesLibraryStore((s) => s.openSaveTemplate)
  const openShare = useFilesLibraryStore((s) => s.openShare)
  const { capabilities } = useFilesOps()
  const shareHeldBack = capabilities.share !== true
  const createHeldBack = capabilities.createDocuments !== true
  const onDesktop = t("remote.onDesktop")

  if (entry.trashedAt !== undefined) {
    return [
      {
        type: "item",
        id: "preview",
        label: t("actions.preview"),
        icon: EyeIcon,
        onSelect: () => actions.preview(entry),
      },
      {
        type: "item",
        id: "restore",
        label: t("actions.restore"),
        icon: RotateCcwIcon,
        onSelect: () => void actions.restore([entry]),
      },
      { type: "separator", id: "sep-delete" },
      {
        type: "item",
        id: "delete-forever",
        label: t("actions.deleteForever"),
        icon: Trash2Icon,
        destructive: true,
        onSelect: () => openDeleteForever([entry.key]),
      },
    ]
  }

  const favorite = entry.favoritedAt !== undefined
  const nodes: FilesMenuNode[] = [
    {
      type: "item",
      id: "open",
      label: t("actions.open"),
      icon: SquareArrowOutUpRightIcon,
      onSelect: () => void actions.open(entry),
    },
    {
      type: "item",
      id: "preview",
      label: t("actions.preview"),
      icon: EyeIcon,
      onSelect: () => actions.preview(entry),
    },
    {
      type: "item",
      id: "use-in-chat",
      label: t("actions.useInChat"),
      icon: MessageSquarePlusIcon,
      onSelect: () => void actions.useInChat(entry),
    },
    { type: "separator", id: "sep-organize" },
    {
      type: "item",
      id: "favorite",
      label: favorite ? t("actions.unfavorite") : t("actions.favorite"),
      icon: favorite ? StarOffIcon : StarIcon,
      onSelect: () => void actions.toggleFavorite(entry),
    },
    {
      type: "item",
      id: "move",
      label: t("actions.moveToFolder"),
      icon: FolderInputIcon,
      onSelect: () => openMove([entry.key]),
    },
  ]
  if (entry.folderId !== undefined) {
    nodes.push({
      type: "item",
      id: "unfile",
      label: t("actions.removeFromFolder"),
      icon: FolderMinusIcon,
      onSelect: () => void actions.moveToFolder([entry], null),
    })
  }
  nodes.push(
    {
      type: "item",
      id: "rename",
      label: t("actions.rename"),
      icon: PencilIcon,
      hint: "F2",
      onSelect: () => openRename(entry.key),
    },
    {
      type: "item",
      id: "duplicate",
      label: t("actions.duplicate"),
      icon: CopyIcon,
      onSelect: () => void actions.duplicate(entry),
    },
    ...(hasDocumentDraft(entry) && isUnifiedTemplatePlatformEnabled()
      ? [
          {
            type: "item",
            id: "save-template",
            label: t("actions.saveAsTemplate"),
            icon: LayoutTemplateIcon,
            disabled: createHeldBack,
            ...(createHeldBack ? { hint: onDesktop } : {}),
            onSelect: () => openSaveTemplate(entry.key),
          } satisfies FilesMenuNode,
        ]
      : []),
    {
      type: "item",
      id: "download",
      label: t("actions.download"),
      icon: DownloadIcon,
      onSelect: () => void actions.download(entry),
    },
    {
      type: "item",
      id: "share",
      label: t("actions.share"),
      icon: Share2Icon,
      disabled: shareHeldBack || !isFilesShareAvailable(entry),
      ...(shareHeldBack ? { hint: onDesktop } : {}),
      onSelect: () => openShare([entry.key]),
    },
    { type: "separator", id: "sep-trash" },
    {
      type: "item",
      id: "trash",
      label: t("actions.trash"),
      icon: Trash2Icon,
      destructive: true,
      onSelect: () => void actions.trash([entry]),
    }
  )
  return nodes
}

export interface FilesItemMenuProps {
  entry: FilesEntry
  title: string
  actions: FilesActions
  className?: string
}

/** The "⋯" button on a card or row. */
export function FilesItemMenu({ entry, title, actions, className }: FilesItemMenuProps) {
  const t = useTranslations("files")
  const nodes = useFilesItemMenu(entry, actions)
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
        <FilesMenuNodes nodes={nodes} kind="dropdown" testIdPrefix="files-action" />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Right-click on a card or row opens the same entries. */
export function FilesItemContextMenu({
  entry,
  actions,
  children,
}: {
  entry: FilesEntry
  actions: FilesActions
  children: ReactNode
}) {
  const nodes = useFilesItemMenu(entry, actions)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent onClick={(event) => event.stopPropagation()}>
        <FilesMenuNodes nodes={nodes} kind="context" testIdPrefix="files-context" />
      </ContextMenuContent>
    </ContextMenu>
  )
}
