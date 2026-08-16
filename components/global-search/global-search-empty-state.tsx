"use client"

/**
 * What the dialog shows before anything is typed (ADR-0129): recent queries
 * as chips, recently opened items, then each provider's suggestions (recent
 * conversations, primary commands, pages…). Recents are the only persisted
 * search state and can be removed one by one or cleared.
 */

import { ClockIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useSyncExternalStore } from "react"

import { CommandGroup, CommandItem, CommandSeparator } from "@/components/ui/command"
import {
  clearRecentQueries,
  getGlobalSearchRecentsRevision,
  listRecentItems,
  listRecentQueries,
  removeRecentItem,
  removeRecentQuery,
  subscribeGlobalSearchRecents,
  type RecentItem,
} from "@/lib/global-search/recents"
import type { GlobalSearchGroup, GlobalSearchItem } from "@/lib/global-search/types"

import { kindIcon } from "./kind-icons"
import { GlobalSearchResultRow } from "./global-search-result-row"

export interface GlobalSearchEmptyStateProps {
  suggestions: readonly GlobalSearchGroup[]
  onPickQuery: (query: string) => void
  onPickRecent: (item: RecentItem) => void
  onSelect: (item: GlobalSearchItem) => void
}

/** Snapshot of both recent lists, re-read whenever the store bumps. */
export function useGlobalSearchRecents(): { queries: string[]; items: RecentItem[] } {
  const revision = useSyncExternalStore(
    subscribeGlobalSearchRecents,
    getGlobalSearchRecentsRevision,
    getGlobalSearchRecentsRevision
  )
  // Re-read on every revision — the lists are tiny and localStorage-backed.
  void revision
  return { queries: listRecentQueries(), items: listRecentItems() }
}

export function GlobalSearchEmptyState({
  suggestions,
  onPickQuery,
  onPickRecent,
  onSelect,
}: GlobalSearchEmptyStateProps) {
  const t = useTranslations("globalSearch")
  const { queries, items } = useGlobalSearchRecents()

  return (
    <>
      {queries.length > 0 ? (
        <div className="px-3 pt-2 pb-1" data-testid="global-search-recent-queries">
          <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{t("recents.queries")}</span>
            <button
              type="button"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => clearRecentQueries()}
              className="hover:text-foreground"
            >
              {t("recents.clear")}
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {queries.map((query) => (
              <span
                key={query}
                className="flex h-6 items-center gap-1 rounded-full border border-border bg-muted/40 pl-2 pr-1 text-xs"
              >
                <button
                  type="button"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => onPickQuery(query)}
                  className="flex items-center gap-1 hover:text-foreground"
                >
                  <ClockIcon className="size-3 text-muted-foreground" aria-hidden />
                  <span className="max-w-[160px] truncate">{query}</span>
                </button>
                <button
                  type="button"
                  aria-label={`${t("recents.remove")}: ${query}`}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => removeRecentQuery(query)}
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <XIcon className="size-3" aria-hidden />
                </button>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {items.length > 0 ? (
        <CommandGroup heading={t("recents.items")} data-testid="global-search-recent-items">
          {items.map((item) => {
            const Icon = kindIcon(item.kind)
            return (
              <CommandItem
                key={item.id}
                value={`recent:${item.id}`}
                onSelect={() => onPickRecent(item)}
                className="items-center gap-3"
              >
                <Icon className="size-4 text-muted-foreground" aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{item.title}</span>
                  {item.subtitle ? (
                    <span className="truncate text-xs text-muted-foreground">{item.subtitle}</span>
                  ) : null}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{t(`kinds.${item.kind}`)}</span>
                  <button
                    type="button"
                    aria-label={`${t("recents.remove")}: ${item.title}`}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      event.stopPropagation()
                      removeRecentItem(item.id)
                    }}
                    className="rounded-full p-0.5 hover:bg-muted hover:text-foreground"
                  >
                    <XIcon className="size-3" aria-hidden />
                  </button>
                </span>
              </CommandItem>
            )
          })}
        </CommandGroup>
      ) : null}

      {suggestions.map((group, index) => (
        <div key={group.providerId}>
          {index > 0 || items.length > 0 ? <CommandSeparator /> : null}
          <CommandGroup heading={t(`kinds.${group.kind}`)}>
            {group.items.map((item) => (
              <GlobalSearchResultRow key={item.id} item={item} onSelect={onSelect} />
            ))}
          </CommandGroup>
        </div>
      ))}
    </>
  )
}
