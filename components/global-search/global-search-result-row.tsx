"use client"

/**
 * One result row (ADR-0129): icon / avatar, highlighted title, optional
 * highlighted subtitle (snippet, description, path), badge chips (current,
 * archived, occurrence count, branch copies), and a right-aligned meta column
 * (role, section, route, relative time). Pure presentation — selection is the
 * dialog's.
 */

import { useFormatter, useNow, useTranslations } from "next-intl"
import { AtSignIcon } from "lucide-react"

import { MatchHighlight } from "@/components/chat/completion/match-highlight"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { Badge } from "@/components/ui/badge"
import { CommandItem } from "@/components/ui/command"
import { isReferenceable } from "@/lib/global-search/referenceable"
import type { GlobalSearchItem } from "@/lib/global-search/types"
import { cn } from "@/lib/utils"

import { KIND_ICONS } from "./kind-icons"

/** Show a relative time only for events younger than this. */
const RELATIVE_TIME_MAX_MS = 30 * 86_400_000

export interface GlobalSearchResultRowProps {
  item: GlobalSearchItem
  onSelect: (item: GlobalSearchItem) => void
  /** Also render the kind label on the right (used inside mixed lists). */
  showKind?: boolean
  /**
   * Stage this row as context for the active conversation instead of opening
   * it. Omitted where the palette has no composer to stage into.
   */
  onReference?: (item: GlobalSearchItem) => void
}

export function GlobalSearchResultRow({
  item,
  onSelect,
  showKind = false,
  onReference,
}: GlobalSearchResultRowProps) {
  const t = useTranslations("globalSearch")
  const format = useFormatter()
  const now = useNow()
  const disabledReason = item.extra?.disabledReason
  // A static lookup, not a component created during render.
  const Icon = item.icon && "lucide" in item.icon ? item.icon.lucide : KIND_ICONS[item.kind]
  const timeLabel =
    item.timestamp !== undefined && Number.isFinite(item.timestamp)
      ? now.getTime() - item.timestamp < RELATIVE_TIME_MAX_MS
        ? format.relativeTime(new Date(item.timestamp), now)
        : format.dateTime(new Date(item.timestamp), { dateStyle: "medium" })
      : null

  return (
    <CommandItem
      value={item.id}
      onSelect={() => onSelect(item)}
      disabled={Boolean(disabledReason)}
      className="group items-start gap-3 py-2"
      data-testid="global-search-row"
      data-kind={item.kind}
      // cmdk lowercases and trims `data-value`, so the dialog's ⌘↵ handler
      // cannot look a row up by it. This carries the id verbatim.
      data-item-id={item.id}
    >
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        {item.icon && "avatar" in item.icon ? (
          <AvatarBadge subject={item.icon.avatar} size={20} />
        ) : (
          <Icon className="size-4" aria-hidden />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <MatchHighlight
            text={item.title}
            positions={[...(item.titlePositions ?? [])]}
            className="truncate text-sm font-medium"
            markClassName="text-foreground"
          />
          {item.extra?.current ? (
            <Badge variant="secondary" className="h-4 shrink-0 px-1 text-[10px]">
              {t("badges.current")}
            </Badge>
          ) : null}
          {item.extra?.archived ? (
            <Badge
              variant="outline"
              className="h-4 shrink-0 px-1 text-[10px] text-muted-foreground"
            >
              {t("badges.archived")}
            </Badge>
          ) : null}
          {item.extra?.occurrenceCount && item.extra.occurrenceCount > 1 ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {t("badges.occurrences", { count: item.extra.occurrenceCount })}
            </span>
          ) : null}
          {item.extra?.otherBranchCount ? (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {t("badges.branchCopies", { count: item.extra.otherBranchCount })}
            </span>
          ) : null}
        </span>
        {item.subtitle ? (
          <MatchHighlight
            text={item.subtitle}
            positions={[...(item.subtitlePositions ?? [])]}
            className={cn(
              "text-xs text-muted-foreground",
              item.kind === "message" ? "line-clamp-2" : "truncate"
            )}
            markClassName="text-foreground"
          />
        ) : null}
        {disabledReason ? (
          <span className="text-[10px] text-muted-foreground">{disabledReason}</span>
        ) : null}
      </span>
      {onReference && isReferenceable(item) && !disabledReason ? (
        // A secondary action, so the row's primary meaning (open it) is
        // unchanged. `onMouseDown` + preventDefault because `CommandItem`
        // selects on click, and selecting would open the row out from under
        // the reference.
        <button
          type="button"
          data-testid="global-search-reference"
          aria-label={t("referenceAria", { title: item.title })}
          title={t("referenceHint")}
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onReference(item)
          }}
          className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-data-[selected=true]:opacity-100"
        >
          <AtSignIcon className="size-3.5" aria-hidden />
        </button>
      ) : null}
      <span className="ml-auto flex shrink-0 flex-col items-end gap-0.5 pl-2 text-[11px] text-muted-foreground">
        {showKind ? <span>{t(`kinds.${item.kind}`)}</span> : null}
        {item.meta ? <span className="max-w-[160px] truncate">{item.meta}</span> : null}
        {timeLabel ? <span className="tabular-nums opacity-80">{timeLabel}</span> : null}
      </span>
    </CommandItem>
  )
}
