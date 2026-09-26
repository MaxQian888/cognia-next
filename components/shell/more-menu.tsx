"use client"

/**
 * The "More" overflow popover body — a filter field over category sections.
 *
 * Shared by the expanded sidebar (`sidebar-nav-section.tsx`) and the
 * collapsed icon rail (`guild-rail.tsx`): one menu, two hosts. The query
 * lives and dies inside — Radix unmounts the popover on close, so the
 * field resets itself.
 *
 * Keyboard: the filter keeps focus when the menu opens; Enter opens the first
 * match, ↓ moves into the list, and ↑ / ↓ / Home / End walk the entries (↑ on
 * the first one returns to the filter). Each entry can be pinned or hidden
 * from its own row, and carries the same live count the rail would draw for
 * it (`lib/shell/nav-badges.ts`).
 */

import { useMemo, useRef, useState, type KeyboardEvent } from "react"
import { useTranslations } from "next-intl"
import { EyeOffIcon, PinIcon, SearchIcon, SlidersHorizontalIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { HOVER_REVEAL_CONTROL_CLASS } from "@/lib/ui/hover-reveal"
import { cn } from "@/lib/utils"
import { CountPill } from "@/components/shared/count-pill"
import { navBadgeCount, type NavBadgeCounts } from "@/lib/shell/nav-badges"
import type { SidebarCatalogItem } from "@/lib/shell/sidebar-nav"
import { groupSidebarNavByCategory } from "@/types/shell/sidebar"

/** Marks an entry's open button for the menu's own arrow-key walk. */
const MORE_ITEM_ATTR = "data-more-item"

export interface MoreMenuContentProps {
  /** The overflow list — `resolved.overflow` from `useSidebarLayout`. */
  items: SidebarCatalogItem[]
  isActive: (route: string) => boolean
  /** Live counts by catalog id (`useNavBadges`). */
  badges: NavBadgeCounts
  onOpen: (route: string) => void
  onPin: (id: string) => void
  /** Take an entry off the navigation entirely, not just out of this menu. */
  onHide: (id: string) => void
  onCustomize: () => void
  /** data-testid prefix — "sidebar-nav-more" / "guild-more". */
  testIdPrefix: string
}

export function MoreMenuContent({
  items,
  isActive,
  badges,
  onOpen,
  onPin,
  onHide,
  onCustomize,
  testIdPrefix,
}: MoreMenuContentProps) {
  const t = useTranslations("desktop.guildRail")
  const [query, setQuery] = useState("")
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((item) =>
      // Localized label first; id/route/aliases match the ⌘K provider's
      // keyword set so "More" and global search agree on what a term finds.
      [t(item.i18nKey), item.id, item.route, item.aliasKey ? t(`aliases.${item.aliasKey}`) : ""]
        .join(" ")
        .toLowerCase()
        .includes(q)
    )
  }, [items, query, t])

  const sections = useMemo(() => groupSidebarNavByCategory(filtered), [filtered])
  // What Enter in the filter opens: the first entry as displayed, which is
  // the first of the first category, not the first of `filtered`.
  const firstMatch = sections[0]?.items[0]

  const entries = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>(`[${MORE_ITEM_ATTR}]`) ?? [])

  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && firstMatch) {
      event.preventDefault()
      onOpen(firstMatch.route)
      return
    }
    if (event.key === "ArrowDown") {
      const first = entries()[0]
      if (!first) return
      event.preventDefault()
      first.focus()
    }
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = entries()
    const index = list.indexOf(event.target as HTMLElement)
    // Only the entries' own open buttons walk; the pin / hide buttons beside
    // them keep plain Tab behaviour.
    if (index < 0) return
    let next: HTMLElement | undefined
    if (event.key === "ArrowDown") next = list[Math.min(list.length - 1, index + 1)]
    else if (event.key === "ArrowUp") next = index === 0 ? undefined : list[index - 1]
    else if (event.key === "Home") next = list[0]
    else if (event.key === "End") next = list[list.length - 1]
    else return
    event.preventDefault()
    if (next) next.focus()
    else inputRef.current?.focus()
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="relative border-b px-1 py-1">
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          autoFocus
          value={query}
          onKeyDown={onFilterKeyDown}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("moreFilterPlaceholder")}
          aria-label={t("moreFilterPlaceholder")}
          className="h-7 border-0 bg-transparent pl-7 pr-7 text-xs shadow-none focus-visible:ring-0 dark:bg-transparent"
          data-testid={`${testIdPrefix}-filter`}
        />
        {query ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="absolute right-1.5 top-1/2 size-6 -translate-y-1/2"
            onClick={() => setQuery("")}
            aria-label={t("moreFilterClear")}
            data-testid={`${testIdPrefix}-filter-clear`}
          >
            <XIcon aria-hidden className="size-3.5" />
          </Button>
        ) : null}
      </div>

      <div
        ref={listRef}
        onKeyDown={onListKeyDown}
        className="max-h-[min(480px,60vh)] overflow-y-auto p-1"
      >
        {sections.length > 0 ? (
          sections.map((section) => (
            <div key={section.category}>
              <div className="px-2 pb-0.5 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/75 first:pt-1">
                {t(`categories.${section.category}`)}
              </div>
              {section.items.map((item) => {
                const label = t(item.i18nKey)
                const active = isActive(item.route)
                const count = navBadgeCount(badges, item.id)
                return (
                  <div
                    key={item.id}
                    className={cn(
                      "group flex items-center rounded hover:bg-accent",
                      active && "bg-primary/10 text-foreground"
                    )}
                  >
                    <Button
                      variant="ghost"
                      onClick={() => onOpen(item.route)}
                      {...{ [MORE_ITEM_ATTR]: "" }}
                      aria-current={active ? "page" : undefined}
                      aria-label={count > 0 ? `${label}, ${t("badgeCount", { count })}` : undefined}
                      data-testid={`${testIdPrefix}-item-${item.id}`}
                      className="h-auto min-w-0 flex-1 justify-start rounded px-2 py-1.5 font-normal"
                    >
                      <item.Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
                      <CountPill
                        count={count}
                        decorative
                        testId={`${testIdPrefix}-badge-${item.id}`}
                      />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("customize.pinItem", { item: label })}
                      title={t("customize.pinItem", { item: label })}
                      data-testid={`${testIdPrefix}-pin-${item.id}`}
                      onClick={() => onPin(item.id)}
                      className={cn(
                        "size-7 shrink-0",
                        HOVER_REVEAL_CONTROL_CLASS,
                        "group-focus-within:opacity-100"
                      )}
                    >
                      <PinIcon className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("customize.hideNamed", { item: label })}
                      title={t("customize.hideNamed", { item: label })}
                      data-testid={`${testIdPrefix}-hide-${item.id}`}
                      onClick={() => onHide(item.id)}
                      className={cn(
                        "mr-1 size-7 shrink-0",
                        HOVER_REVEAL_CONTROL_CLASS,
                        "group-focus-within:opacity-100"
                      )}
                    >
                      <EyeOffIcon className="size-3.5" />
                    </Button>
                  </div>
                )
              })}
            </div>
          ))
        ) : (
          <div
            className="px-3 py-6 text-center text-xs text-muted-foreground"
            data-testid={`${testIdPrefix}-empty`}
          >
            {t("moreFilterEmpty", { query: query.trim() })}
          </div>
        )}
      </div>

      <Separator />
      <div className="p-1">
        <Button
          variant="ghost"
          onClick={onCustomize}
          data-testid={`${testIdPrefix}-customize`}
          className="h-auto w-full justify-start rounded px-2 py-1.5 font-normal"
        >
          <SlidersHorizontalIcon className="size-4 text-muted-foreground" />
          <span className="flex-1 text-left">{t("customize.title")}</span>
        </Button>
      </div>
    </div>
  )
}
