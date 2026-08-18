"use client"

import React, { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Search, BarChart3, ArrowUpDown, Check } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ProviderSidebarItem } from "./provider-sidebar-item"
import type { ProviderConnectionStatus } from "./provider-sidebar-item"
import type { ProviderDiagnosticBadgeStatus } from "./provider-sidebar-item"
import { PROVIDER_CATEGORY_FILTERS, type ProviderSortBy } from "./provider-status-utils"

/** Provider-type categories shown as an equal-width tab strip. */
const CATEGORY_KEYS = PROVIDER_CATEGORY_FILTERS

const SORT_OPTIONS: ReadonlyArray<{ value: ProviderSortBy; key: string }> = [
  { value: "name", key: "sortName" },
  { value: "status", key: "sortStatus" },
  { value: "lastUsed", key: "sortLastUsed" },
]

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
    diagnosticStatus?: ProviderDiagnosticBadgeStatus
  }>
  selectedId: string | null
  onSelect: (id: string) => void
  onCompareClick: () => void
  categoryFilter: string
  onCategoryChange: (category: string) => void
  /** Controlled status filter — the parent owns it so it can persist it and
   *  so a rail rendered in two hosts (column / sheet) never diverges. */
  statusFilter?: StatusFilter
  onStatusFilterChange?: (status: StatusFilter) => void
  /** Sort order (persisted `ProviderUIPreferences.sortBy`). */
  sortBy?: ProviderSortBy
  onSortByChange?: (sortBy: ProviderSortBy) => void
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
  statusFilter = "all",
  onStatusFilterChange,
  sortBy = "name",
  onSortByChange,
  searchQuery,
  onSearchChange,
  addButton,
  emptyState,
  hasActiveFilters = false,
  onClearFilters,
}: ProviderSidebarProps) {
  const t = useTranslations("providers")

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
    onStatusFilterChange?.("all")
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
        {onSortByChange && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="outline"
                className="h-9 w-9 shrink-0"
                aria-label={t("sidebar.sortLabel")}
                title={t("sidebar.sortLabel")}
                data-testid="provider-sort-trigger"
              >
                <ArrowUpDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuLabel className="text-xs">{t("sidebar.sortLabel")}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {SORT_OPTIONS.map(({ value, key }) => (
                <DropdownMenuItem
                  key={value}
                  onSelect={() => onSortByChange(value)}
                  data-testid={`provider-sort-${value}`}
                  className="text-xs"
                >
                  <span className="flex-1">{t(`sidebar.${key}`)}</span>
                  {sortBy === value && <Check className="h-3.5 w-3.5" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {addButton}
      </div>

      {/* Category filters. An equal-share strip truncated every label longer
          than ~6 characters at the default rail width ("Flag…", "Aggr…"), and
          an overflow strip hid the last tab entirely. Wrapping pills keep
          every label legible: they take a second line on a narrow rail instead
          of eating characters, and stay one line once the rail is widened. */}
      <div className="min-w-0 border-b px-3 py-2">
        <Tabs value={categoryFilter} onValueChange={onCategoryChange} className="min-w-0">
          {/* `h-auto!` / `overflow-visible!`: the shared TabsList pins a 36px
              height for horizontal tabs and the settings panel adds
              overflow-x-auto — together they clipped the wrapped second row. */}
          <TabsList className="flex h-auto! w-full min-w-0 flex-wrap justify-start gap-1 overflow-visible! bg-transparent p-0">
            {CATEGORY_KEYS.map((key) => (
              <TabsTrigger
                key={key}
                value={key}
                title={t(`categories.${key}`)}
                className="h-7 flex-none rounded-md border border-transparent px-2 text-xs data-[state=active]:border-border data-[state=active]:bg-muted data-[state=active]:shadow-none"
              >
                {t(`categories.${key}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {/* Status filter — same treatment: wrap, never truncate. */}
      <div
        className="min-w-0 border-b px-3 py-2"
        role="group"
        aria-label={t("sidebar.statusLabel")}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {STATUS_FILTERS.map(({ value, key }) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={statusFilter === value ? "secondary" : "ghost"}
              aria-pressed={statusFilter === value}
              title={t(`sidebar.${key}`)}
              className="h-7 flex-none px-2 text-xs"
              onClick={() => onStatusFilterChange?.(value)}
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
          column.

          `[&_[data-slot=scroll-area-viewport]>div]:!block`: Radix wraps the
          viewport's children in a `display:table` div, which sizes to its
          *content* rather than to the viewport — so a row whose status badge
          and name did not fit pushed the whole list wider than the rail and got
          clipped by the right edge. Forcing that wrapper back to `block` makes
          rows respect the rail width and truncate instead. Same fix as
          `components/desktop/channel-list.tsx`. */}
      <ScrollArea className="min-h-0 flex-1 overflow-x-hidden p-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
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
              diagnosticStatus={p.diagnosticStatus}
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
