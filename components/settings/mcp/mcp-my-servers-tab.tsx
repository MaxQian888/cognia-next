"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { LayoutGridIcon, ListIcon, PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { listMcpServers, updateMcpServer } from "@/lib/db/mcp-servers"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"
import { useMcpPanelView, isMcpPanelView, isMcpPanelGroupBy } from "@/hooks/mcp"
import { loggers } from "@/lib/logging"
import type { McpServer } from "@/lib/claude/types"
import { McpImportDialog } from "../mcp-import-dialog"
import { refreshAgentAvailability } from "../mcp-agent-chip-group"
import { McpServerList } from "./mcp-server-list"
import { cloneServerDraft } from "./mcp-server-utils"
import { McpBatchActionsBar } from "./mcp-batch-actions-bar"
import { blankServerSeed } from "./server-seed"

/**
 * The "My Servers" tab — view/group controls, the filtered + grouped server
 * list, batch action bar, and the create/import entry points. Outbound-CRUD
 * wiring reuses the existing `lib/db/mcp-servers` helpers verbatim.
 */
export function McpMyServersTab() {
  const t = useTranslations("mcp")
  const tList = useTranslations("mcp.list")
  const tView = useTranslations("mcp.view")

  const search = useMcpPanelStore((s) => s.search)
  const transportFilter = useMcpPanelStore((s) => s.transportFilter)
  const statusFilter = useMcpPanelStore((s) => s.statusFilter)
  const selection = useMcpPanelStore((s) => s.selection)
  const toggleSelection = useMcpPanelStore((s) => s.toggleSelection)
  const openCreate = useMcpPanelStore((s) => s.openCreate)
  const openEdit = useMcpPanelStore((s) => s.openEdit)
  const setDeleteTarget = useMcpPanelStore((s) => s.setDeleteTarget)
  const resetFilters = useMcpPanelStore((s) => s.resetFilters)

  const { view, groupBy, isFavorite, setView, setGroupBy, toggleFavorite } = useMcpPanelView()

  const liveServers = useLiveQuery(() => listMcpServers(), [])
  const servers = useMemo(() => liveServers ?? [], [liveServers])

  const visibleServers = useMemo(() => {
    const q = search.trim().toLowerCase()
    return servers.filter((s) => {
      if (transportFilter !== "all" && s.transport !== transportFilter) return false
      if (statusFilter === "enabled" && !s.enabled) return false
      if (statusFilter === "disabled" && s.enabled) return false
      if (!q) return true
      const cfg = s.config as { command?: string; url?: string; args?: string[] }
      const haystack = [
        s.name,
        s.transport,
        cfg.command ?? "",
        cfg.url ?? "",
        (cfg.args ?? []).join(" "),
      ]
        .join(" ")
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [servers, search, transportFilter, statusFilter])

  const filtersActive =
    search.trim().length > 0 || transportFilter !== "all" || statusFilter !== "all"

  const handleToggle = async (server: McpServer, enabled: boolean) => {
    try {
      await updateMcpServer(server.id, { enabled })
      loggers.mcp.info("settings.serverToggled", { id: server.id, enabled })
    } catch (err) {
      loggers.mcp.error("settings.serverToggleFailed", err, { id: server.id })
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-3" data-testid="mcp-my-servers-tab">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          value={view}
          onValueChange={(v) => v && isMcpPanelView(v) && void setView(v)}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="grid" aria-label={tView("grid")}>
            <LayoutGridIcon className="size-3.5" />
          </ToggleGroupItem>
          <ToggleGroupItem value="list" aria-label={tView("list")}>
            <ListIcon className="size-3.5" />
          </ToggleGroupItem>
        </ToggleGroup>

        <Select value={groupBy} onValueChange={(v) => isMcpPanelGroupBy(v) && void setGroupBy(v)}>
          <SelectTrigger size="sm" className="w-auto gap-1.5" aria-label={tView("groupBy")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{tView("groupNone")}</SelectItem>
            <SelectItem value="transport">{tView("groupTransport")}</SelectItem>
            <SelectItem value="status">{tView("groupStatus")}</SelectItem>
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-1.5">
          <McpImportDialog onImported={refreshAgentAvailability} />
          <Button
            size="sm"
            variant="outline"
            onClick={() => void blankServerSeed().then(openCreate)}
          >
            <PlusIcon className="size-3.5 sm:mr-1.5" />
            <span className="hidden sm:inline">{t("addServer")}</span>
          </Button>
        </div>
      </div>

      {servers.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
          {tList("empty")}
        </p>
      ) : visibleServers.length === 0 && filtersActive ? (
        <p className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
          {tList("noMatch")}{" "}
          <button type="button" className="underline hover:text-foreground" onClick={resetFilters}>
            {tList("clearFilters")}
          </button>
        </p>
      ) : (
        <McpServerList
          servers={visibleServers}
          view={view}
          groupBy={groupBy}
          selection={selection}
          isFavorite={isFavorite}
          onToggleSelect={toggleSelection}
          onToggleFavorite={(id) => void toggleFavorite(id)}
          onToggle={handleToggle}
          onEdit={openEdit}
          onClone={(server) => openCreate(cloneServerDraft(server))}
          onDelete={(server) => setDeleteTarget({ serverId: server.id, name: server.name })}
        />
      )}

      <McpBatchActionsBar servers={servers} />
    </div>
  )
}
