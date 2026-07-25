"use client"

import React, { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Search, BarChart3 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { ProviderSidebarItem } from "./provider-sidebar-item"
import type { ProviderConnectionStatus } from "./provider-sidebar-item"

/** Provider-type categories shown as a horizontally-scrollable tab strip. */
const CATEGORY_KEYS = ["all", "ai", "local", "voice", "vision", "custom"] as const

/** Connection-status quick filters applied locally to the visible list. */
const STATUS_FILTERS = [
  { value: "all", key: "statusAll" },
  { value: "connected", key: "statusConnected" },
  { value: "not-configured", key: "statusUnconfigured" },
  { value: "error", key: "statusError" },
] as const

type StatusFilter = (typeof STATUS_FILTERS)[number]["value"]

interface ProviderSidebarProps {
  providers: Array<{
    id: string
    name: string
    icon?: string | React.ReactNode
    subtitle: string
    status: ProviderConnectionStatus
    modelCount?: number
  }>
  selectedId: string | null
  onSelect: (id: string) => void
  onCompareClick: () => void
  categoryFilter: string
  onCategoryChange: (category: string) => void
  searchQuery: string
  onSearchChange: (query: string) => void
  addButton?: React.ReactNode
  /**
   * Shown inside the list area when the user genuinely has no providers.
   *
   * It belongs HERE, not in place of the whole sidebar: replacing the sidebar
   * took the search box and the category tabs down with it, so picking a
   * category with no matches (e.g. "custom" before adding one) removed every
   * control that could undo the filter. There was no way back.
   */
  emptyState?: React.ReactNode
  /** True when the parent's search or category filter is narrowing the list. */
  hasActiveFilters?: boolean
  /** Reset the parent's search + category filters. */
  onClearFilters?: () => void
}

export function ProviderSidebar({
  providers,
  selectedId,
  onSelect,
  onCompareClick,
  categoryFilter,
  onCategoryChange,
  searchQuery,
  onSearchChange,
  addButton,
  emptyState,
  hasActiveFilters = false,
  onClearFilters,
}: ProviderSidebarProps) {
  const t = useTranslations("providers")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")

  // Local status filter narrows the already-(category/search)-filtered list the
  // parent hands down. Kept here so the parent stays unaware of the extra axis.
  const visibleProviders = useMemo(
    () => (statusFilter === "all" ? providers : providers.filter((p) => p.status === statusFilter)),
    [providers, statusFilter]
  )

  const total = visibleProviders.length
  const active = visibleProviders.filter((p) => p.status === "connected").length

  // Whether SOMETHING the user chose is hiding rows — the parent's search /
  // category, or this component's own status filter.
  const filtersNarrowTheList = hasActiveFilters || statusFilter !== "all"

  const clearFilters = () => {
    setStatusFilter("all")
    onClearFilters?.()
  }

  // `@container/provider-rail`: the rail is a fixed-width column, so its
  // children must size against it rather than the viewport.
  return (
    <div className="@container/provider-rail flex h-full w-full min-w-0 flex-col overflow-hidden">
      {/* Top: search + add button */}
      <div className="flex min-w-0 gap-2 border-b p-3">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder={t("sidebar.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        {addButton}
      </div>

      {/* Category filters — horizontally scrollable so the labels never squash
          into each other on a narrow rail. */}
      <div className="min-w-0 border-b px-3 py-2">
        <Tabs value={categoryFilter} onValueChange={onCategoryChange} className="min-w-0">
          <div className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <TabsList className="inline-flex h-8 w-max">
              {CATEGORY_KEYS.map((key) => (
                <TabsTrigger key={key} value={key} className="shrink-0 whitespace-nowrap px-2.5">
                  {t(`categories.${key}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Tabs>
      </div>

      {/* Status filter */}
      <div
        className="min-w-0 border-b px-3 py-2"
        role="group"
        aria-label={t("sidebar.statusLabel")}
      >
        <div className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {STATUS_FILTERS.map(({ value, key }) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={statusFilter === value ? "secondary" : "ghost"}
              aria-pressed={statusFilter === value}
              className={cn("h-7 shrink-0 whitespace-nowrap px-2 text-xs")}
              onClick={() => setStatusFilter(value)}
            >
              {t(`sidebar.${key}`)}
            </Button>
          ))}
        </div>
      </div>

      {/* Provider list (scrollable). Themed `ScrollArea` rather than a native
          `overflow-y-auto`: every dialog in this feature already uses it, so a
          raw OS scrollbar here made the rail and the dialogs look like two
          different products. `min-h-0` keeps it shrinkable inside the flex
          column. */}
      <ScrollArea className="min-h-0 flex-1 overflow-x-hidden p-1">
        {visibleProviders.length === 0 ? (
          filtersNarrowTheList ? (
            // A filtered-to-nothing list used to render as a blank box with no
            // explanation and no way out.
            <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
              <p className="text-xs text-muted-foreground">{t("sidebar.noMatches")}</p>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={clearFilters}>
                {t("sidebar.clearFilters")}
              </Button>
            </div>
          ) : (
            emptyState
          )
        ) : (
          visibleProviders.map((p) => (
            <ProviderSidebarItem
              key={p.id}
              providerId={p.id}
              name={p.name}
              icon={p.icon}
              subtitle={p.subtitle}
              status={p.status}
              isSelected={p.id === selectedId}
              onClick={onSelect}
              modelCount={p.modelCount}
            />
          ))
        )}
      </ScrollArea>

      {/* Model Compare button */}
      <div className="min-w-0 border-t px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onCompareClick} className="w-full justify-start">
          <BarChart3 className="mr-2 h-4 w-4" />
          {t("sidebar.modelCompare")}
        </Button>
      </div>

      {/* Stats bar */}
      <div className="min-w-0 border-t px-3 py-2 text-xs text-muted-foreground">
        {t("sidebar.stats", { total, active })}
      </div>
    </div>
  )
}
