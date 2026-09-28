"use client"

import { useFormatter, useTranslations } from "next-intl"
import { StarIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { displayTitle, type FilesActions } from "@/hooks/files-library/use-files-actions"
import type { FilesEntry } from "@/lib/files-library/types"
import { formatBytes } from "@/lib/storage/usage"
import { cn } from "@/lib/utils"
import { FilesEntryIcon } from "./files-entry-icon"
import { FilesImageThumb } from "./files-image-thumb"
import { FilesItemMenu } from "./files-item-menu"

export interface FilesRowProps {
  entry: FilesEntry
  actions: FilesActions
  selected: boolean
}

/** One Files entry in the list layout. Same interactions as the card. */
export function FilesRow({ entry, actions, selected }: FilesRowProps) {
  const t = useTranslations("files")
  const format = useFormatter()
  const title = displayTitle(entry, t)

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t("card.open", { title })}
      aria-pressed={selected}
      data-testid={`files-row-${entry.key}`}
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
        "group flex min-w-0 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-accent"
      )}
    >
      <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
        {entry.kind === "image" ? (
          <FilesImageThumb hash={entry.sourceId} alt={title} className="size-full" />
        ) : (
          <FilesEntryIcon entry={entry} className="size-5" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          <span>{t(`kinds.${entry.kind}`)}</span>
          {entry.byteSize !== undefined ? <span>· {formatBytes(entry.byteSize)}</span> : null}
          {!entry.originAlive ? (
            <Badge variant="secondary" className="h-4 px-1 text-[10px]">
              {t("card.sourceDeleted")}
            </Badge>
          ) : null}
          {entry.sessionIds.length > 1 ? (
            <span>· {t("card.usedIn", { count: entry.sessionIds.length })}</span>
          ) : null}
        </p>
      </div>
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
        {format.dateTime(entry.updatedAt, { dateStyle: "medium" })}
      </span>
      {entry.favoritedAt !== undefined ? (
        <StarIcon
          className="size-4 shrink-0 fill-amber-400 text-amber-400"
          aria-label={t("card.favorite")}
        />
      ) : (
        <span className="size-4 shrink-0" aria-hidden />
      )}
      <FilesItemMenu
        entry={entry}
        title={title}
        actions={actions}
        className="size-7 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100"
      />
    </div>
  )
}
