"use client"

/**
 * One Files entry on a phone-width page (ADR-0223 §9): a two-line list item
 * instead of a table row.
 *
 *   [thumb]  Quarterly plan.md ★ 🔗                         2 hr   ⋯
 *            Roadmap chat · 12 KB · Document
 *
 * A tap previews the item (the page opens the preview drawer); a long-press
 * starts selection with this item selected, and while selecting a tap toggles
 * instead. The "⋯" button is a 44px target with the same menu as the desktop
 * row, plus "Select". There is no right-click menu — on a touch screen Radix
 * would raise it on the same long-press — and no drag: moving goes through
 * "Move to folder…" and the bulk dock.
 */

import { memo, useMemo } from "react"
import { useLocale, useTranslations } from "next-intl"
import { CheckIcon, CheckSquareIcon, Link2Icon, MoreHorizontalIcon, StarIcon, Users2Icon } from "lucide-react"

import { LongPress } from "@/components/interactions/long-press"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { displayTitle, type FilesActions } from "@/hooks/files-library/use-files-actions"
import { entryRecency } from "@/lib/files-library/aggregate"
import { filesFormatOf } from "@/lib/files-library/format"
import { isThumbnailEntry, thumbnailHash } from "@/lib/files-library/thumbnail"
import type { FilesEntry } from "@/lib/files-library/types"
import { relativeCompact } from "@/lib/notifications/functional-toast/relative-time"
import { formatBytes } from "@/lib/storage/usage"
import { cn } from "@/lib/utils"

import { FilesEntryIcon } from "../files-entry-icon"
import { FilesImageThumb } from "../files-image-thumb"
import { useFilesItemMenu } from "../files-item-menu"
import { FilesMenuNodes, type FilesMenuNode } from "../files-menu"

export interface FilesMobileRowProps {
  entry: FilesEntry
  actions: FilesActions
  /** Selection mode: a tap toggles instead of previewing. */
  selecting: boolean
  selected: boolean
  /** Shown in the preview drawer. */
  previewed: boolean
  /** A long-press (or "Select" in the menu) starts selection with this item. */
  onStartSelecting: (key: string) => void
  onToggle: (key: string) => void
  now: number
}

export const FilesMobileRow = memo(function FilesMobileRow({
  entry,
  actions,
  selecting,
  selected,
  previewed,
  onStartSelecting,
  onToggle,
  now,
}: FilesMobileRowProps) {
  const t = useTranslations("files")
  const locale = useLocale()
  const title = displayTitle(entry, t)
  const trashed = entry.trashedAt !== undefined
  // The view's clock ticks once a minute; something newer than it reads "now".
  const activity = Math.min(trashed ? entry.trashedAt! : entryRecency(entry), now)
  const itemNodes = useFilesItemMenu(entry, actions)
  const nodes = useMemo<FilesMenuNode[]>(
    () =>
      selecting
        ? itemNodes
        : [
            {
              type: "item",
              id: "select",
              label: t("mobile.select"),
              icon: CheckSquareIcon,
              onSelect: () => onStartSelecting(entry.key),
            },
            { type: "separator", id: "select-separator" },
            ...itemNodes,
          ],
    [itemNodes, selecting, t, onStartSelecting, entry.key]
  )

  const source = entry.originSessionTitle
    ? entry.originSessionTitle
    : entry.ownedByFiles
      ? t("columns.uploaded")
      : null
  const details = [
    source,
    entry.byteSize !== undefined ? formatBytes(entry.byteSize) : null,
    t(`formats.${filesFormatOf(entry)}`),
  ].filter((part): part is string => part !== null)

  return (
    <li
      className={cn(
        "not-last:border-b flex min-w-0 items-center gap-1 pr-1 transition-colors",
        (selected || previewed) && "bg-accent/60"
      )}
      data-testid={`files-mobile-row-${entry.key}`}
      data-files-key={entry.key}
      data-state={selected ? "selected" : undefined}
    >
      <LongPress
        onLongPress={() => onStartSelecting(entry.key)}
        className="relative flex min-w-0 flex-1"
      >
        <button
          type="button"
          onClick={() => (selecting ? onToggle(entry.key) : actions.preview(entry))}
          aria-label={selecting ? t("selection.select", { title }) : t("card.open", { title })}
          aria-pressed={selecting ? selected : undefined}
          className="absolute inset-0 z-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 active:bg-muted/50"
          data-testid={`files-mobile-open-${entry.key}`}
        />
        <span className="pointer-events-none relative z-10 flex min-h-14 w-full min-w-0 items-center gap-3 py-2 pl-3">
          <span className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/40">
            {isThumbnailEntry(entry) ? (
              <FilesImageThumb hash={thumbnailHash(entry)} alt="" className="size-full" />
            ) : (
              <FilesEntryIcon entry={entry} className="size-5" />
            )}
            {selecting ? (
              // Drawn, not a control: the row button is what toggles, and a
              // checkbox (itself a button) inside it would nest buttons.
              <span
                aria-hidden
                className={cn(
                  "absolute inset-0 grid place-items-center",
                  selected ? "bg-primary/80 text-primary-foreground" : "bg-background/60"
                )}
                data-testid={`files-mobile-check-${entry.key}`}
                data-state={selected ? "checked" : "unchecked"}
              >
                <span
                  className={cn(
                    "grid size-5 place-items-center rounded-sm border",
                    selected ? "border-primary-foreground" : "border-input bg-background"
                  )}
                >
                  {selected ? <CheckIcon className="size-3.5" /> : null}
                </span>
              </span>
            ) : null}
          </span>
          <span className="min-w-0 flex-1 space-y-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-medium">{title}</span>
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
                  data-testid="files-mobile-shared-link"
                />
              ) : null}
              <span
                className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground tabular-nums"
                data-testid={`files-mobile-activity-${entry.key}`}
              >
                {trashed
                  ? t("mobile.deletedAgo", { when: relativeCompact(activity, now, locale) })
                  : relativeCompact(activity, now, locale)}
              </span>
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="truncate" data-testid={`files-mobile-details-${entry.key}`}>
                {details.join(" · ")}
              </span>
              {!entry.originAlive ? (
                <Badge variant="secondary" className="h-4 shrink-0 px-1 text-[10px]">
                  {t("card.sourceDeleted")}
                </Badge>
              ) : null}
            </span>
          </span>
        </span>
      </LongPress>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            aria-label={t("card.menu", { title })}
            data-testid={`files-item-menu-${entry.key}`}
          >
            <MoreHorizontalIcon className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <FilesMenuNodes nodes={nodes} kind="dropdown" testIdPrefix="files-action" />
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
})
