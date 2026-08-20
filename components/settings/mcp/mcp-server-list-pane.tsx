"use client"

import { useTranslations } from "next-intl"
import {
  FilterIcon,
  PlusIcon,
  RowsIcon,
  SearchIcon,
  ServerIcon,
  StretchHorizontalIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"
import { isMcpPanelGroupBy, isMcpPanelView, type McpPanelGroupBy } from "@/hooks/mcp"
import type { McpServer } from "@cognia/agent-config-types"
import { McpServerList } from "./mcp-server-list"
import type { McpRowDensity } from "./mcp-server-row"

interface Props {
  /** Servers surviving search + filters. */
  servers: McpServer[]
  /** Total configured servers, so the empty states can tell apart "none" from "no match". */
  totalCount: number
  density: McpRowDensity
  groupBy: McpPanelGroupBy
  selection: Set<string>
  activeId: string | null
  isFavorite: (id: string) => boolean
  toolCounts: ReadonlyMap<string, number>
  deniedToolCounts: ReadonlyMap<string, number>
  onSetDensity: (density: McpRowDensity) => void
  onSetGroupBy: (groupBy: McpPanelGroupBy) => void
  onOpen: (id: string) => void
  onToggleSelect: (id: string) => void
  onToggleSelectAll: () => void
  onToggleFavorite: (id: string) => void
  onToggle: (server: McpServer, enabled: boolean) => void | Promise<void>
  onCreate: () => void
  onEdit: (id: string) => void
  onClone: (server: McpServer) => void
  onExport: (server: McpServer) => void
  onDelete: (server: McpServer) => void
  onBrowsePresets: () => void
}

/**
 * The master rail: search, view controls, and the server list.
 *
 * The controls live here rather than in the panel header because they only
 * ever act on this list — hoisting them made the header reflow on every tab
 * switch, which is what the old layout did.
 */
export function McpServerListPane({
  servers,
  totalCount,
  density,
  groupBy,
  selection,
  activeId,
  isFavorite,
  toolCounts,
  deniedToolCounts,
  onSetDensity,
  onSetGroupBy,
  onOpen,
  onToggleSelect,
  onToggleSelectAll,
  onToggleFavorite,
  onToggle,
  onCreate,
  onEdit,
  onClone,
  onExport,
  onDelete,
  onBrowsePresets,
}: Props) {
  const t = useTranslations("mcp")
  const tList = useTranslations("mcp.list")
  const tView = useTranslations("mcp.view")

  const search = useMcpPanelStore((s) => s.search)
  const setSearch = useMcpPanelStore((s) => s.setSearch)
  const transportFilter = useMcpPanelStore((s) => s.transportFilter)
  const statusFilter = useMcpPanelStore((s) => s.statusFilter)
  const setFilterSheetOpen = useMcpPanelStore((s) => s.setFilterSheetOpen)
  const resetFilters = useMcpPanelStore((s) => s.resetFilters)

  const activeFilterCount = (transportFilter !== "all" ? 1 : 0) + (statusFilter !== "all" ? 1 : 0)
  const filtersActive = search.trim().length > 0 || activeFilterCount > 0
  const allVisibleSelected = servers.length > 0 && servers.every((s) => selection.has(s.id))

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="mcp-server-list-pane">
      <div className="shrink-0 space-y-1.5 border-b px-2 py-2">
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={tList("searchPlaceholder")}
              className="h-8 pl-8 text-xs"
              aria-label={tList("searchPlaceholder")}
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            className="relative size-8 shrink-0"
            onClick={() => setFilterSheetOpen(true)}
            aria-label={tView("filters")}
          >
            <FilterIcon className="size-3.5" />
            {activeFilterCount > 0 && (
              <Badge
                variant="secondary"
                className="absolute -right-1 -top-1 h-3.5 min-w-3.5 px-1 text-[9px]"
                data-testid="mcp-filter-count"
              >
                {activeFilterCount}
              </Badge>
            )}
          </Button>
          <Button
            size="icon"
            className="size-8 shrink-0"
            onClick={onCreate}
            aria-label={t("addServer")}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        </div>

        <div className="flex items-center gap-1.5">
          <Select
            value={groupBy}
            onValueChange={(value) => isMcpPanelGroupBy(value) && onSetGroupBy(value)}
          >
            <SelectTrigger
              size="sm"
              className="h-7 min-w-0 flex-1 text-[11px]"
              aria-label={tView("groupBy")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{tView("groupNone")}</SelectItem>
              <SelectItem value="transport">{tView("groupTransport")}</SelectItem>
              <SelectItem value="status">{tView("groupStatus")}</SelectItem>
            </SelectContent>
          </Select>
          <ToggleGroup
            type="single"
            value={density === "compact" ? "list" : "grid"}
            onValueChange={(value) =>
              value &&
              isMcpPanelView(value) &&
              onSetDensity(value === "list" ? "compact" : "comfortable")
            }
            variant="outline"
            size="sm"
            className="shrink-0"
          >
            <ToggleGroupItem value="grid" aria-label={tView("comfortable")} className="h-7 px-2">
              <StretchHorizontalIcon className="size-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label={tView("compact")} className="h-7 px-2">
              <RowsIcon className="size-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {servers.length > 0 && (
          <div className="flex items-center gap-2 px-0.5">
            <Checkbox
              checked={allVisibleSelected}
              onCheckedChange={onToggleSelectAll}
              aria-label={tList("selectAllAria")}
            />
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={onToggleSelectAll}
              className="h-auto p-0 text-[11px] text-muted-foreground"
            >
              {allVisibleSelected
                ? tList("clearSelection")
                : tList("selectAll", { count: servers.length })}
            </Button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {totalCount === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-md border border-dashed p-6 text-center">
            <ServerIcon className="size-7 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">{tList("empty")}</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button size="sm" onClick={onCreate}>
                <PlusIcon className="size-3.5 sm:mr-1.5" />
                {t("addServer")}
              </Button>
              <Button size="sm" variant="outline" onClick={onBrowsePresets}>
                {tList("emptyBrowsePresets")}
              </Button>
            </div>
          </div>
        ) : servers.length === 0 ? (
          <p className="rounded-md border border-dashed p-5 text-center text-xs text-muted-foreground">
            {tList("noMatch")}{" "}
            {filtersActive && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={resetFilters}
              >
                {tList("clearFilters")}
              </Button>
            )}
          </p>
        ) : (
          <McpServerList
            servers={servers}
            density={density}
            groupBy={groupBy}
            selection={selection}
            activeId={activeId}
            isFavorite={isFavorite}
            toolCounts={toolCounts}
            deniedToolCounts={deniedToolCounts}
            onOpen={onOpen}
            onToggleSelect={onToggleSelect}
            onToggleFavorite={onToggleFavorite}
            onToggle={onToggle}
            onEdit={onEdit}
            onClone={onClone}
            onExport={onExport}
            onDelete={onDelete}
          />
        )}
      </div>
    </div>
  )
}
