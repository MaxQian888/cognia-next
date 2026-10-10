"use client"

/**
 * One Files entry in the grid (ADR-0223). A plain click selects the card and
 * previews it; Ctrl/⌘ and Shift extend the selection; a double click (or
 * Enter) opens it in its own surface. Pictures — chat images and image uploads
 * — fill the card; everything else shows its title over a type glyph. The card
 * drags onto a folder or the Trash, and right-click opens the "⋯" menu.
 */

import { Surface } from "@/components/surface/surface"
import { useFormatter, useTranslations } from "next-intl"
import { Link2Icon, StarIcon, Users2Icon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { displayTitle, type FilesActions } from "@/hooks/files-library/use-files-actions"
import type { RangeSelectionMouseEvent } from "@/hooks/ui/use-range-selection"
import { isThumbnailEntry, thumbnailHash } from "@/lib/files-library/thumbnail"
import type { FilesEntry } from "@/lib/files-library/types"
import { HOVER_REVEAL_CONTROL_CLASS } from "@/lib/ui/hover-reveal"
import { cn } from "@/lib/utils"

import { useFilesItemDrag } from "./files-dnd"
import { FilesEntryIcon } from "./files-entry-icon"
import { FilesImageThumb } from "./files-image-thumb"
import { FilesItemContextMenu, FilesItemMenu } from "./files-item-menu"

export interface FilesCardProps {
  entry: FilesEntry
  actions: FilesActions
  /** Shown in the preview pane. */
  previewed: boolean
  selected: boolean
  /** Some item is selected, so every card shows its checkbox. */
  selecting: boolean
  onSelect: (key: string, event: RangeSelectionMouseEvent) => void
}

export function FilesCard({
  entry,
  actions,
  previewed,
  selected,
  selecting,
  onSelect,
}: FilesCardProps) {
  const t = useTranslations("files")
  const format = useFormatter()
  const title = displayTitle(entry, t)
  // Destructured: the compiler would treat the whole result as a ref.
  const { setNodeRef, attributes, listeners, isDragging } = useFilesItemDrag(entry.key)
  const favorite = entry.favoritedAt !== undefined
  const trashed = entry.trashedAt !== undefined
  const picture = isThumbnailEntry(entry)
  // Over a photo the default badge ink disappears into the gradient.
  const badgeTone = picture ? "border-white/50 bg-black/40 text-white" : undefined

  return (
    <FilesItemContextMenu entry={entry} actions={actions}>
      <Surface
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        role="button"
        tabIndex={0}
        aria-label={t("card.open", { title })}
        aria-pressed={selected}
        data-testid={`files-card-${entry.key}`}
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
          "group relative flex aspect-square min-w-0 cursor-pointer flex-col overflow-hidden rounded-xl border bg-card text-left transition-colors outline-none hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
          (selected || previewed) && "border-primary ring-1 ring-primary",
          isDragging && "opacity-50"
        )}
      >
        {picture ? (
          <FilesImageThumb
            hash={thumbnailHash(entry)}
            alt={title}
            className="absolute inset-0 size-full"
          />
        ) : (
          <>
            <p className="line-clamp-2 px-4 pt-4 pr-10 pl-10 text-sm font-medium break-all">
              {title}
            </p>
            <div className="flex flex-1 items-center justify-center">
              <FilesEntryIcon entry={entry} />
            </div>
          </>
        )}

        <div
          className={cn(
            "relative mt-auto flex flex-wrap items-center gap-1 px-4 pb-3 text-xs text-muted-foreground",
            picture && "bg-gradient-to-t from-black/70 to-transparent pt-6 text-white"
          )}
        >
          <span className="truncate">
            {trashed
              ? t("card.trashed", {
                  date: format.dateTime(entry.trashedAt!, { dateStyle: "medium" }),
                })
              : t("card.modified", {
                  date: format.dateTime(entry.updatedAt, { dateStyle: "medium" }),
                })}
          </span>
          {!entry.originAlive ? (
            <Badge
              variant="secondary"
              className={cn("h-5 px-1.5 text-[10px]", badgeTone)}
              data-testid="files-card-source-deleted"
            >
              {t("card.sourceDeleted")}
            </Badge>
          ) : null}
          {entry.ownedByFiles ? (
            <Badge variant="outline" className={cn("h-5 px-1.5 text-[10px]", badgeTone)}>
              {t("card.owned")}
            </Badge>
          ) : null}
          {entry.sessionIds.length > 1 ? (
            <Badge
              variant="outline"
              className={cn("h-5 px-1.5 text-[10px]", badgeTone)}
              data-testid="files-card-used-in"
            >
              {t("card.usedIn", { count: entry.sessionIds.length })}
            </Badge>
          ) : null}
        </div>

        <div
          className={cn(
            "absolute top-2 left-2 flex rounded-md p-1",
            picture && "bg-black/40",
            !selecting && !selected && HOVER_REVEAL_CONTROL_CLASS,
            !selecting && !selected && "group-focus-within:opacity-100"
          )}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <Checkbox
            checked={selected}
            onCheckedChange={() =>
              onSelect(entry.key, { ctrlKey: true, metaKey: false, shiftKey: false })
            }
            aria-label={t("selection.select", { title })}
            className={picture ? "border-white" : undefined}
            data-testid={`files-card-check-${entry.key}`}
          />
        </div>

        <div className="absolute top-2 right-2 flex items-center gap-0.5">
          {entry.sharedWithMe ? (
            <Users2Icon
              className={cn("size-4 text-muted-foreground", picture && "text-white")}
              aria-label={t("card.sharedWithMe")}
              data-testid="files-card-shared"
            />
          ) : null}
          {entry.sharedLinks ? (
            <Link2Icon
              className={cn("size-4 text-muted-foreground", picture && "text-white")}
              aria-label={t("card.sharedByLink", { count: entry.sharedLinks })}
              data-testid="files-card-shared-link"
            />
          ) : null}
          {favorite ? (
            <StarIcon
              className="size-4 fill-amber-400 text-amber-400"
              aria-label={t("card.favorite")}
              data-testid="files-card-favorite"
            />
          ) : null}
          <FilesItemMenu
            entry={entry}
            title={title}
            actions={actions}
            className={cn(
              HOVER_REVEAL_CONTROL_CLASS,
              "size-7 group-focus-within:opacity-100",
              picture && "bg-black/40 text-white hover:bg-black/60"
            )}
          />
        </div>
      </Surface>
    </FilesItemContextMenu>
  )
}
