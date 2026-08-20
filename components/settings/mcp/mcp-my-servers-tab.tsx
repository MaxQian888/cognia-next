"use client"

import { useEffect, useMemo } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import { ServerIcon } from "lucide-react"

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { getDb } from "@/lib/db/schema"
import { listMcpServers, updateMcpServer } from "@/lib/db/mcp-servers"
import { resolveDeniedToolNames } from "@/lib/mcp/tool-rules"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"
import { useMcpPanelView } from "@/hooks/mcp"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { useAgentStatuses } from "@/hooks/agent/use-agent-status"
import { loggers } from "@cognia/logging"
import type { McpServer } from "@cognia/agent-config-types"
import { McpBatchActionsBar } from "./mcp-batch-actions-bar"
import { McpFilterSheet } from "./mcp-filter-sheet"
import { McpServerDetail } from "./mcp-server-detail"
import { McpServerListPane } from "./mcp-server-list-pane"
import { cloneServerDraft } from "./mcp-server-utils"
import { blankServerSeed } from "./server-seed"

/**
 * "My Servers" — a master-detail pane: the rail lists every configured server,
 * the detail half owns one server's tools, agent projection, auth and logs.
 *
 * Replaces a card grid whose tiles all showed the same four badges and hid
 * everything else behind a modal. On mobile the detail half becomes a Sheet,
 * because a 320px rail beside a detail pane does not fit a phone.
 *
 * Both halves render inside a fixed-height flex box and scroll independently,
 * so switching tabs or selecting a row never changes the panel's height.
 */
export function McpMyServersTab() {
  const t = useTranslations("mcp")

  const search = useMcpPanelStore((s) => s.search)
  const transportFilter = useMcpPanelStore((s) => s.transportFilter)
  const statusFilter = useMcpPanelStore((s) => s.statusFilter)
  const trustFilter = useMcpPanelStore((s) => s.trustFilter)
  const selection = useMcpPanelStore((s) => s.selection)
  const toggleSelection = useMcpPanelStore((s) => s.toggleSelection)
  const selectAll = useMcpPanelStore((s) => s.selectAll)
  const clearSelection = useMcpPanelStore((s) => s.clearSelection)
  const openCreate = useMcpPanelStore((s) => s.openCreate)
  const openEdit = useMcpPanelStore((s) => s.openEdit)
  const setDeleteTarget = useMcpPanelStore((s) => s.setDeleteTarget)
  const setActiveTab = useMcpPanelStore((s) => s.setActiveTab)
  const detailServerId = useMcpPanelStore((s) => s.detailServerId)
  const openDetail = useMcpPanelStore((s) => s.openDetail)
  const closeDetail = useMcpPanelStore((s) => s.closeDetail)
  const openExport = useMcpPanelStore((s) => s.openExport)

  const isMobile = useIsMobile()
  const { view, groupBy, isFavorite, setView, setGroupBy, toggleFavorite } = useMcpPanelView()
  const density = view === "list" ? "compact" : "comfortable"

  const liveServers = useLiveQuery(() => listMcpServers(), [])
  const servers = useMemo(() => liveServers ?? [], [liveServers])

  // One Agent-file snapshot subscription at the catalog seam, shared by the
  // rail and the detail pane. A 100-server panel no longer mounts 100 hooks.
  const { statuses: agentStatuses, loading: agentStatusesLoading } = useAgentStatuses(servers)

  // One capability query for the whole rail — the alternative (a hook per row)
  // is what made the old grid slow to open with many servers.
  const capabilityRows = useLiveQuery(() => getDb().mcpCapabilityCache.toArray(), [])
  const { toolNames, toolCounts, deniedToolCounts } = useMemo(() => {
    const freshest = new Map<string, string[]>()
    const seenAt = new Map<string, number>()
    for (const row of capabilityRows ?? []) {
      if ((seenAt.get(row.serverId) ?? -1) >= row.updatedAt) continue
      seenAt.set(row.serverId, row.updatedAt)
      freshest.set(
        row.serverId,
        row.tools.map((tool) => tool.name)
      )
    }
    const counts = new Map<string, number>()
    const denied = new Map<string, number>()
    for (const server of servers) {
      const tools = freshest.get(server.id)
      if (!tools) continue
      counts.set(server.id, tools.length)
      const deniedNames = new Set(resolveDeniedToolNames(server, tools))
      denied.set(server.id, tools.filter((tool) => deniedNames.has(tool)).length)
    }
    return { toolNames: freshest, toolCounts: counts, deniedToolCounts: denied }
  }, [capabilityRows, servers])

  const visibleServers = useMemo(() => {
    const q = search.trim().toLowerCase()
    return servers.filter((s) => {
      if (transportFilter !== "all" && s.transport !== transportFilter) return false
      if (statusFilter === "enabled" && !s.enabled) return false
      if (statusFilter === "disabled" && s.enabled) return false
      if (trustFilter !== "all" && (s.trust?.state ?? "legacy") !== trustFilter) return false
      if (!q) return true
      const cfg = s.config as { command?: string; url?: string; args?: string[] }
      const haystack = [
        s.name,
        s.displayName ?? "",
        s.transport,
        cfg.command ?? "",
        cfg.url ?? "",
        (cfg.args ?? []).join(" "),
        // Tool names too: "which server gives me `create_issue`?" is the
        // question a tool list makes askable, and the rail is where it lands.
        (toolNames.get(s.id) ?? []).join(" "),
      ]
        .join(" ")
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [servers, search, transportFilter, statusFilter, trustFilter, toolNames])

  // Keep the detail pane pointed at a row that is actually visible. A still-
  // visible selection is left alone; otherwise the first visible server takes
  // over. Skipped on mobile so the Sheet never opens unprompted.
  useEffect(() => {
    if (isMobile) return
    const ids = visibleServers.map((s) => s.id)
    if (detailServerId && ids.includes(detailServerId)) return
    if (ids.length > 0) openDetail(ids[0])
    else closeDetail()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `detailServerId` is read but deliberately not a dep: re-running on selection writes would fight user clicks (mirrors skill-panel).
  }, [visibleServers, isMobile])

  const activeServer = servers.find((s) => s.id === detailServerId) ?? null

  const allVisibleSelected =
    visibleServers.length > 0 && visibleServers.every((s) => selection.has(s.id))
  const toggleSelectAll = () => {
    if (allVisibleSelected) clearSelection()
    else selectAll(visibleServers.map((s) => s.id))
  }

  const handleToggle = async (server: McpServer, enabled: boolean) => {
    try {
      await updateMcpServer(server.id, { enabled })
      loggers.mcp.info("settings.serverToggled", { id: server.id, enabled })
    } catch (err) {
      loggers.mcp.error("settings.serverToggleFailed", err, { id: server.id })
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const listPane = (
    <McpServerListPane
      servers={visibleServers}
      totalCount={servers.length}
      density={density}
      groupBy={groupBy}
      selection={selection}
      activeId={isMobile ? null : detailServerId}
      isFavorite={isFavorite}
      toolCounts={toolCounts}
      deniedToolCounts={deniedToolCounts}
      onSetDensity={(next) => void setView(next === "compact" ? "list" : "grid")}
      onSetGroupBy={(next) => void setGroupBy(next)}
      onOpen={openDetail}
      onToggleSelect={toggleSelection}
      onToggleSelectAll={toggleSelectAll}
      onToggleFavorite={(id) => void toggleFavorite(id)}
      onToggle={handleToggle}
      onCreate={() => void blankServerSeed().then(openCreate)}
      onEdit={openEdit}
      onClone={(server) => openCreate(cloneServerDraft(server))}
      onExport={(server) => openExport([server.id])}
      onDelete={(server) => setDeleteTarget({ serverId: server.id, name: server.name })}
      onBrowsePresets={() => setActiveTab("presets")}
    />
  )

  const detail = activeServer ? (
    <McpServerDetail
      key={activeServer.id}
      server={activeServer}
      favorite={isFavorite(activeServer.id)}
      agentStatuses={agentStatuses}
      agentStatusesLoading={agentStatusesLoading}
      onToggle={handleToggle}
      onToggleFavorite={(id) => void toggleFavorite(id)}
      onEdit={openEdit}
      onClone={(server) => openCreate(cloneServerDraft(server))}
      onExport={(server) => openExport([server.id])}
      onDelete={(server) => setDeleteTarget({ serverId: server.id, name: server.name })}
    />
  ) : null

  return (
    <div
      className="grid min-h-0 w-full flex-1 grid-cols-1 md:grid-cols-[minmax(240px,300px)_minmax(0,1fr)] md:divide-x"
      data-testid="mcp-my-servers-tab"
      data-layout="master-detail"
    >
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">{listPane}</div>

      {!isMobile && (
        <div className="hidden min-h-0 min-w-0 flex-col overflow-hidden md:flex">
          {detail ?? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
              <ServerIcon className="size-8 text-muted-foreground/30" />
              <p className="text-xs text-muted-foreground">{t("detail.noSelection")}</p>
            </div>
          )}
        </div>
      )}

      {isMobile && (
        <Sheet
          open={Boolean(activeServer)}
          onOpenChange={(open) => {
            if (!open) closeDetail()
          }}
        >
          <SheetContent side="right" className="w-full overflow-hidden p-0 sm:max-w-lg">
            <SheetHeader className="sr-only">
              <SheetTitle>{activeServer?.displayName || activeServer?.name}</SheetTitle>
              <SheetDescription>{t("detail.connectionSubtitle")}</SheetDescription>
            </SheetHeader>
            {detail}
          </SheetContent>
        </Sheet>
      )}

      <McpBatchActionsBar servers={servers} />
      <McpFilterSheet />
    </div>
  )
}
