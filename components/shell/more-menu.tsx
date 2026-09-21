"use client"

/**
 * The "More" overflow popover body — a filter field over category sections.
 *
 * Shared by the expanded sidebar (`sidebar-nav-section.tsx`) and the
 * collapsed icon rail (`guild-rail.tsx`): one menu, two hosts. The query
 * lives and dies inside — Radix unmounts the popover on close, so the
 * field resets itself.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { PinIcon, SearchIcon, SlidersHorizontalIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import type { SidebarCatalogItem } from "@/lib/shell/sidebar-nav"
import { groupSidebarNavByCategory } from "@/types/shell/sidebar"

export interface MoreMenuContentProps {
  /** The overflow list — `resolved.overflow` from `useSidebarLayout`. */
  items: SidebarCatalogItem[]
  isActive: (route: string) => boolean
  onOpen: (route: string) => void
  onPin: (id: string) => void
  onCustomize: () => void
  /** data-testid prefix — "sidebar-nav-more" / "guild-more". */
  testIdPrefix: string
}

export function MoreMenuContent({
  items,
  isActive,
  onOpen,
  onPin,
  onCustomize,
  testIdPrefix,
}: MoreMenuContentProps) {
  const t = useTranslations("desktop.guildRail")
  const [query, setQuery] = useState("")

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

  return (
    <div className="flex min-h-0 flex-col">
      <div className="relative border-b px-1 py-1">
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          autoFocus
          value={query}
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

      <div className="max-h-[min(480px,60vh)] overflow-y-auto p-1">
        {sections.length > 0 ? (
          sections.map((section) => (
            <div key={section.category}>
              <div className="px-2 pb-0.5 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/75 first:pt-1">
                {t(`categories.${section.category}`)}
              </div>
              {section.items.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    "group flex items-center rounded hover:bg-accent",
                    isActive(item.route) && "bg-primary/10 text-foreground"
                  )}
                >
                  <Button
                    variant="ghost"
                    onClick={() => onOpen(item.route)}
                    data-testid={`${testIdPrefix}-item-${item.id}`}
                    className="h-auto min-w-0 flex-1 justify-start rounded px-2 py-1.5 font-normal"
                  >
                    <item.Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-left">{t(item.i18nKey)}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("customize.pinItem", { item: t(item.i18nKey) })}
                    data-testid={`${testIdPrefix}-pin-${item.id}`}
                    onClick={() => onPin(item.id)}
                    className="mr-1 size-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                  >
                    <PinIcon className="size-3.5" />
                  </Button>
                </div>
              ))}
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
          <span className="text-[11px] text-muted-foreground">
            {t("moreCount", { count: filtered.length })}
          </span>
        </Button>
      </div>
    </div>
  )
}
