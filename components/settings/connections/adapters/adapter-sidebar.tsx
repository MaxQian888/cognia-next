"use client"

/**
 * Master list sidebar for Settings → Connections → Adapters.
 *
 * Mirrors the AI Provider page sidebar (`components/settings/provider/
 * provider-sidebar.tsx`): a pinned search box + add button, an
 * All / Enabled / Disabled status filter, a list of `AdapterListRow`s, and a
 * footer stats line. The parent (`AdaptersTab`) owns the search / filter
 * state and passes the already-filtered `adapters` so the same component
 * renders identically in the desktop column and the mobile `Sheet` drawer.
 */

import { useTranslations } from "next-intl"
import { SearchIcon } from "lucide-react"

import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

import { AdapterListRow } from "./adapter-list-row"

export type AdapterStatusFilter = "all" | "enabled" | "disabled"

export interface AdapterSidebarProps {
  /** Already filtered by the parent (search + status filter). */
  adapters: AdapterInstanceRow[]
  /** Pending + sending outbound jobs keyed by adapter id. */
  pendingByAdapter: Map<string, number>
  onConfigure: (row: AdapterInstanceRow) => void
  searchQuery: string
  onSearchChange: (query: string) => void
  statusFilter: AdapterStatusFilter
  onStatusFilterChange: (filter: AdapterStatusFilter) => void
  /** Add-connector button, rendered next to the search box. */
  addButton: React.ReactNode
  /** Fired after a row selects itself — used to close the mobile drawer. */
  onAfterSelect?: () => void
}

export function AdapterSidebar({
  adapters,
  pendingByAdapter,
  onConfigure,
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  addButton,
  onAfterSelect,
}: AdapterSidebarProps) {
  const t = useTranslations("settings.connections.adapters")

  const total = adapters.length
  const enabled = adapters.filter((row) => row.enabled).length

  return (
    <div className="flex h-full w-full min-w-0 flex-col" data-testid="adapter-sidebar">
      {/* Search + add */}
      <div className="flex min-w-0 gap-2 border-b p-3">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder={t("sidebar.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            data-testid="adapter-sidebar-search"
          />
        </div>
        {addButton}
      </div>

      {/* Status filter */}
      <div className="min-w-0 border-b px-3 py-2">
        <Tabs
          value={statusFilter}
          onValueChange={(v) => onStatusFilterChange(v as AdapterStatusFilter)}
          className="min-w-0"
        >
          <TabsList className="h-8 w-full">
            <TabsTrigger value="all" className="min-w-0">
              {t("sidebar.filterAll")}
            </TabsTrigger>
            <TabsTrigger value="enabled" className="min-w-0">
              {t("sidebar.filterEnabled")}
            </TabsTrigger>
            <TabsTrigger value="disabled" className="min-w-0">
              {t("sidebar.filterDisabled")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* List */}
      <ul className="min-w-0 flex-1 space-y-0.5 overflow-y-auto p-1">
        {adapters.map((row) => (
          <AdapterListRow
            key={row.id}
            row={row}
            pendingCount={pendingByAdapter.get(row.id) ?? 0}
            onConfigure={onConfigure}
            onAfterSelect={onAfterSelect}
          />
        ))}
      </ul>

      {/* Stats */}
      <div className="min-w-0 border-t px-3 py-2 text-xs text-muted-foreground">
        {t("sidebar.stats", { total, enabled })}
      </div>
    </div>
  )
}
