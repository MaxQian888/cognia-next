"use client"

/**
 * The two empty states every conversation list shares: the desktop sidebar,
 * the phone drawer and the conversation manager (`/conversations`).
 *
 * - {@link ConversationListEmptyState} — the view itself holds nothing: no
 *   conversations yet (with a way to start one), or an empty archive (with the
 *   way back to the active list).
 * - {@link ConversationNarrowedEmptyState} — the view holds something, and a
 *   search or the filters narrowed it to nothing; each cause gets its own exit.
 *
 * Moved out of `components/desktop/channel-list.tsx` so the other lists stop
 * drawing their own one-line "nothing here" that offers nothing to do.
 */

import { useTranslations } from "next-intl"
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BoxesIcon,
  MessagesSquareIcon,
  PlusIcon,
  SearchIcon,
  TextSearchIcon,
  UsersIcon,
  XIcon,
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
import type { ResolvedConversationSearchOptions } from "@/lib/chat/conversation-search-scope"
import { cn } from "@/lib/utils"

export function ConversationListEmptyState({
  archived,
  team,
  onCreate,
  onShowActive,
  className,
}: {
  archived: boolean
  team: boolean
  onCreate?: () => void
  /**
   * The empty archive's way back. Without it the only exit was the small
   * "Archived ×" chip above — an empty view whose own body offers nothing to
   * do reads as a dead end.
   */
  onShowActive?: () => void
  /** Sizing for the host (a sidebar column, a page body). */
  className?: string
}) {
  const t = useTranslations("desktop.channelList")
  // The archive's title names what is missing; "Conversations" said nothing
  // about why the list was empty.
  const title = archived ? t("emptyArchivedTitle") : team ? t("newConversation") : t("newChat")
  const description = archived ? t("emptyArchivedHint") : team ? t("emptyTeam") : t("emptyDm")
  const actionLabel = team ? t("newConversation") : t("newChat")
  const Icon = archived ? ArchiveIcon : team ? UsersIcon : MessagesSquareIcon

  return (
    <Empty
      className={cn("min-h-48 gap-4 rounded-none border-0 px-5 py-10", className)}
      data-testid="channel-list-empty-state"
    >
      <EmptyHeader>
        <EmptyMedia variant="icon" className="rounded-xl bg-muted/70 text-muted-foreground">
          <Icon className="size-5" />
        </EmptyMedia>
        <EmptyTitle className="text-sm">{title}</EmptyTitle>
        <EmptyDescription className="text-xs">{description}</EmptyDescription>
      </EmptyHeader>
      {onCreate ? (
        <EmptyContent>
          <Button size="sm" onClick={onCreate}>
            <PlusIcon className="size-4" />
            {actionLabel}
          </Button>
        </EmptyContent>
      ) : onShowActive ? (
        <EmptyContent>
          <Button
            size="sm"
            variant="outline"
            onClick={onShowActive}
            data-testid="channel-list-empty-show-active"
          >
            <ArrowLeftIcon className="size-4" />
            {t("backToConversations")}
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  )
}

/** One closed axis of the search scope, offered from the no-results state. */
export interface SearchWidening {
  key: "content" | "archived" | "workspaces"
  /** What opening the axis writes into the persisted search scope. */
  patch: Partial<ResolvedConversationSearchOptions>
}

/**
 * A non-empty view that a search or the filters narrowed to nothing. Three
 * different reasons need different exits — refine the query, drop the
 * filters, or both — so each is offered on its own button rather than one "no
 * results" line that leaves the reader hunting for what they set. A search
 * also gets the ways to look further: clear it, take the words to every
 * conversation's history (the command palette), or open one closed axis of
 * this list's own search scope.
 */
export function ConversationNarrowedEmptyState({
  query,
  activeFilters,
  onClearFilters,
  onClearSearch,
  onSearchEverywhere,
  widenings,
  onWiden,
}: {
  query: string
  activeFilters: number
  onClearFilters: () => void
  onClearSearch: () => void
  onSearchEverywhere: () => void
  widenings: readonly SearchWidening[]
  onWiden: (patch: Partial<ResolvedConversationSearchOptions>) => void
}) {
  const t = useTranslations("desktop.channelList")
  // Filter vocabulary is shared with the mobile list — see
  // `components/chat/conversation-filter-controls.tsx`.
  const tFilters = useTranslations("conversationFilters")
  const searching = query.length > 0
  return (
    <div
      className="flex flex-col items-center gap-3 px-4 py-6 text-center"
      data-testid="channel-list-empty-narrowed"
    >
      <p className="text-xs text-muted-foreground">
        {searching ? t("emptySearch", { query }) : t("emptyFiltered", { count: activeFilters })}
      </p>
      <div className="flex w-full max-w-56 flex-col gap-1.5">
        {searching ? (
          <>
            {widenings.map((widening) => (
              <Button
                key={widening.key}
                size="sm"
                variant="outline"
                className="h-7 justify-start text-xs"
                onClick={() => onWiden(widening.patch)}
                data-testid={`channel-list-empty-widen-${widening.key}`}
              >
                {widening.key === "content" ? (
                  <TextSearchIcon className="size-3.5" />
                ) : widening.key === "archived" ? (
                  <ArchiveIcon className="size-3.5" />
                ) : (
                  <BoxesIcon className="size-3.5" />
                )}
                <span className="truncate">{t(`searchWiden.${widening.key}`)}</span>
              </Button>
            ))}
            <Button
              size="sm"
              variant="outline"
              className="h-7 justify-start text-xs"
              onClick={onSearchEverywhere}
              data-testid="channel-list-empty-search-everywhere"
            >
              <SearchIcon className="size-3.5" />
              <span className="truncate">{t("globalSearch")}</span>
            </Button>
          </>
        ) : null}
        {activeFilters > 0 ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 justify-start text-xs"
            onClick={onClearFilters}
            data-testid="channel-list-empty-clear-filters"
          >
            <XIcon className="size-3.5" />
            <span className="truncate">{tFilters("clearAll")}</span>
          </Button>
        ) : null}
        {searching ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 justify-start text-xs text-muted-foreground"
            onClick={onClearSearch}
            data-testid="channel-list-empty-clear-search"
          >
            <XIcon className="size-3.5" />
            <span className="truncate">{t("clearSearch")}</span>
          </Button>
        ) : null}
      </div>
    </div>
  )
}
