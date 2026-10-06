"use client"

/**
 * One Files entry in the grid. A click previews it, a double click (or Enter
 * then the preview's Open) opens it in its own surface. Images fill the card;
 * everything else shows its title over a type glyph, like the rest of the
 * library surfaces.
 */

import { Surface } from "@/components/surface/surface"
import { useFormatter, useTranslations } from "next-intl"
import { StarIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { displayTitle, type FilesActions } from "@/hooks/files-library/use-files-actions"
import type { FilesEntry } from "@/lib/files-library/types"
import { cn } from "@/lib/utils"
import { HOVER_REVEAL_CONTROL_CLASS } from "@/lib/ui/hover-reveal"
import { FilesEntryIcon } from "./files-entry-icon"
import { FilesImageThumb } from "./files-image-thumb"
import { FilesItemMenu } from "./files-item-menu"

export interface FilesCardProps {
  entry: FilesEntry
  actions: FilesActions
  selected: boolean
}

export function FilesCard({ entry, actions, selected }: FilesCardProps) {
  const t = useTranslations("files")
  const format = useFormatter()
  const title = displayTitle(entry, t)
  const favorite = entry.favoritedAt !== undefined
  const isImage = entry.kind === "image"
  // Over a photo the default badge ink disappears into the gradient.
  const badgeTone = isImage ? "border-white/50 bg-black/40 text-white" : undefined

  return (
    <Surface
      role="button"
      tabIndex={0}
      aria-label={t("card.open", { title })}
      aria-pressed={selected}
      data-testid={`files-card-${entry.key}`}
      onClick={() => actions.preview(entry)}
      onDoubleClick={() => void actions.open(entry)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === "Enter") {
          event.preventDefault()
          void actions.open(entry)
        } else if (event.key === " ") {
          event.preventDefault()
          actions.preview(entry)
        }
      }}
      className={cn(
        "group relative flex aspect-square min-w-0 cursor-pointer flex-col overflow-hidden rounded-xl border bg-card text-left transition-colors outline-none hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-primary ring-1 ring-primary"
      )}
    >
      {isImage ? (
        <FilesImageThumb hash={entry.sourceId} alt={title} className="absolute inset-0 size-full" />
      ) : (
        <>
          <p className="line-clamp-2 px-4 pt-4 pr-10 text-sm font-medium break-all">{title}</p>
          <div className="flex flex-1 items-center justify-center">
            <FilesEntryIcon entry={entry} />
          </div>
        </>
      )}

      <div
        className={cn(
          "relative mt-auto flex flex-wrap items-center gap-1 px-4 pb-3 text-xs text-muted-foreground",
          isImage && "bg-gradient-to-t from-black/70 to-transparent pt-6 text-white"
        )}
      >
        <span className="truncate">
          {t("card.modified", { date: format.dateTime(entry.updatedAt, { dateStyle: "medium" }) })}
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

      <div className="absolute top-2 right-2 flex items-center gap-0.5">
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
            isImage && "bg-black/40 text-white hover:bg-black/60"
          )}
        />
      </div>
    </Surface>
  )
}
