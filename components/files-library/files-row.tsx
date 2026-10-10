"use client"

/**
 * One Files entry in the list (ADR-0223): a table row with the name, where it
 * came from, when it was last active, its size and its format.
 *
 * A plain click selects the row and previews it; Ctrl/⌘ and Shift extend the
 * selection without changing the preview. A double click (or Enter) opens it.
 * The row is draggable onto a folder or the Trash, and right-click opens the
 * same menu as "⋯".
 */

import { useLocale, useTranslations } from "next-intl"
import { Link2Icon, StarIcon, Users2Icon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { TableCell, TableRow } from "@/components/ui/table"
import { displayTitle, type FilesActions } from "@/hooks/files-library/use-files-actions"
import type { RangeSelectionMouseEvent } from "@/hooks/ui/use-range-selection"
import { entryRecency } from "@/lib/files-library/aggregate"
import { filesFormatOf } from "@/lib/files-library/format"
import type { FilesEntry } from "@/lib/files-library/types"
import { relativeCompact } from "@/lib/notifications/functional-toast/relative-time"
import { formatBytes } from "@/lib/storage/usage"
import { isThumbnailEntry, thumbnailHash } from "@/lib/files-library/thumbnail"
import { HOVER_REVEAL_CONTROL_CLASS } from "@/lib/ui/hover-reveal"
import { cn } from "@/lib/utils"

import { useFilesItemDrag } from "./files-dnd"
import { FilesEntryIcon } from "./files-entry-icon"
import { FilesImageThumb } from "./files-image-thumb"
import { FilesItemContextMenu, FilesItemMenu } from "./files-item-menu"

export interface FilesRowProps {
  entry: FilesEntry
  actions: FilesActions
  /** Shown in the preview pane. */
  previewed: boolean
  selected: boolean
  onSelect: (key: string, event: RangeSelectionMouseEvent) => void
  now: number
}

export function FilesRow({ entry, actions, previewed, selected, onSelect, now }: FilesRowProps) {
  const t = useTranslations("files")
  const locale = useLocale()
  const title = displayTitle(entry, t)
  // Destructured: the compiler would treat the whole result as a ref.
  const { setNodeRef, attributes, listeners, isDragging } = useFilesItemDrag(entry.key)
  const trashed = entry.trashedAt !== undefined
  // The view's clock ticks once a minute; something newer than it reads "now".
  const activity = Math.min(trashed ? entry.trashedAt! : entryRecency(entry), now)

  const source = entry.originSessionTitle ? (
    <button
      type="button"
      className="max-w-full truncate rounded-sm text-left hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
      onClick={(event) => {
        event.stopPropagation()
        if (entry.originSessionId) void actions.goToConversation(entry.originSessionId)
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      title={t("columns.openSource", { title: entry.originSessionTitle })}
      data-testid={`files-row-source-${entry.key}`}
    >
      {entry.originSessionTitle}
    </button>
  ) : entry.ownedByFiles ? (
    <span>{t("columns.uploaded")}</span>
  ) : (
    <span aria-label={t("columns.noSource")}>—</span>
  )

  return (
    <FilesItemContextMenu entry={entry} actions={actions}>
      <TableRow
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        // dnd-kit's attributes claim a button role; this stays a table row.
        role="row"
        aria-pressed={undefined}
        tabIndex={0}
        aria-selected={selected}
        aria-label={t("card.open", { title })}
        data-state={selected ? "selected" : undefined}
        data-testid={`files-row-${entry.key}`}
        data-files-key={entry.key}
        data-previewed={previewed || undefined}
        onClick={(event) => {
          onSelect(entry.key, event)
          if (!event.ctrlKey && !event.metaKey && !event.shiftKey) actions.preview(entry)
        }}
        onDoubleClick={() => (trashed ? actions.preview(entry) : void actions.open(entry))}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
          if (event.key === "Enter") {
            event.preventDefault()
            if (trashed) actions.preview(entry)
            else void actions.open(entry)
          } else if (event.key === " ") {
            event.preventDefault()
            onSelect(entry.key, { ctrlKey: true, metaKey: false, shiftKey: event.shiftKey })
          }
        }}
        className={cn(
          "group cursor-pointer outline-none focus-visible:bg-accent/40",
          previewed && "bg-accent/60",
          isDragging && "opacity-50"
        )}
      >
        <TableCell className="w-10 pr-0" onClick={(event) => event.stopPropagation()}>
          <Checkbox
            checked={selected}
            onCheckedChange={() =>
              onSelect(entry.key, { ctrlKey: true, metaKey: false, shiftKey: false })
            }
            aria-label={t("selection.select", { title })}
            data-testid={`files-row-check-${entry.key}`}
          />
        </TableCell>
        <TableCell className="min-w-0">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/40">
              {isThumbnailEntry(entry) ? (
                <FilesImageThumb
                  hash={thumbnailHash(entry)}
                  alt={title}
                  entry={entry}
                  className="size-full"
                />
              ) : (
                <FilesEntryIcon entry={entry} className="size-4" />
              )}
            </div>
            <span className="min-w-0 truncate font-medium">{title}</span>
            {entry.favoritedAt !== undefined ? (
              <StarIcon
                className="size-3.5 shrink-0 fill-amber-400 text-amber-400"
                aria-label={t("card.favorite")}
              />
            ) : null}
            {entry.sharedWithMe ? (
              <Users2Icon
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-label={t("card.sharedWithMe")}
              />
            ) : null}
            {entry.sharedLinks ? (
              <Link2Icon
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-label={t("card.sharedByLink", { count: entry.sharedLinks })}
                data-testid="files-row-shared-link"
              />
            ) : null}
            {!entry.originAlive ? (
              <Badge variant="secondary" className="h-4 shrink-0 px-1 text-[10px]">
                {t("card.sourceDeleted")}
              </Badge>
            ) : null}
          </div>
        </TableCell>
        <TableCell className="hidden truncate text-muted-foreground @xl/files:table-cell">
          {source}
        </TableCell>
        <TableCell
          className="w-28 text-muted-foreground tabular-nums"
          title={new Date(trashed ? entry.trashedAt! : entryRecency(entry)).toLocaleString(locale)}
        >
          {relativeCompact(activity, now, locale)}
        </TableCell>
        <TableCell className="hidden w-24 text-muted-foreground tabular-nums @2xl/files:table-cell">
          {entry.byteSize !== undefined ? formatBytes(entry.byteSize) : "—"}
        </TableCell>
        <TableCell className="hidden w-28 truncate text-muted-foreground @3xl/files:table-cell">
          {t(`formats.${filesFormatOf(entry)}`)}
        </TableCell>
        <TableCell className="w-10 px-1" onClick={(event) => event.stopPropagation()}>
          <FilesItemMenu
            entry={entry}
            title={title}
            actions={actions}
            className={cn(HOVER_REVEAL_CONTROL_CLASS, "size-7 group-focus-within:opacity-100")}
          />
        </TableCell>
      </TableRow>
    </FilesItemContextMenu>
  )
}
