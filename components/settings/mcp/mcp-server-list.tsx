"use client"

import { useTranslations } from "next-intl"

import type { McpServer } from "@cognia/agent-config-types"
import { McpServerRow, type McpRowDensity } from "./mcp-server-row"
import { groupServers, type McpGroupBy } from "./mcp-server-utils"

interface Props {
  servers: McpServer[]
  density: McpRowDensity
  groupBy: McpGroupBy
  selection: Set<string>
  activeId: string | null
  isFavorite: (id: string) => boolean
  /** serverId → discovered tool count, from one shared capability query. */
  toolCounts: ReadonlyMap<string, number>
  /** serverId → how many of those tools the deny rules block. */
  deniedToolCounts: ReadonlyMap<string, number>
  onOpen: (id: string) => void
  onToggleSelect: (id: string) => void
  onToggleFavorite: (id: string) => void
  onToggle: (server: McpServer, enabled: boolean) => void | Promise<void>
  onEdit: (id: string) => void
  onClone: (server: McpServer) => void
  onExport: (server: McpServer) => void
  onDelete: (server: McpServer) => void
}

/**
 * The master list: one column of rows, grouped per `groupBy` with favorites
 * floated to the top of each section. Single-column by construction — this is
 * a rail beside a detail pane, so a responsive card grid here would just make
 * every row narrower.
 *
 * Deliberately unanimated. The rows used to fade in on a `staggerChildren`
 * container, which cost more than it gave: at 0.04s per child a hundred-server
 * rail finishes four seconds after it renders, and when variant propagation
 * does not fire (observed in the settings pane) every row stays stranded at
 * `opacity: 0` — present in the DOM, invisible on screen. The tab crossfade
 * already covers the transition into this list.
 */
export function McpServerList({
  servers,
  density,
  groupBy,
  selection,
  activeId,
  isFavorite,
  toolCounts,
  deniedToolCounts,
  onOpen,
  onToggleSelect,
  onToggleFavorite,
  onToggle,
  onEdit,
  onClone,
  onExport,
  onDelete,
}: Props) {
  const t = useTranslations("mcp.group")
  const groups = groupServers(servers, groupBy, isFavorite)

  return (
    <div className="space-y-3" role="listbox" data-testid="mcp-server-list">
      {groups.map((group) => (
        <div key={group.id} className="space-y-0.5">
          {group.headerKind !== "none" && (
            <h3 className="px-2 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {group.headerKind === "transport" ? group.headerValue : t(group.headerValue)}{" "}
              <span className="text-muted-foreground/60">({group.servers.length})</span>
            </h3>
          )}
          <div className="flex flex-col gap-0.5">
            {group.servers.map((server) => (
              <McpServerRow
                key={server.id}
                server={server}
                density={density}
                active={activeId === server.id}
                selected={selection.has(server.id)}
                favorite={isFavorite(server.id)}
                toolCount={toolCounts.get(server.id)}
                deniedToolCount={deniedToolCounts.get(server.id) ?? 0}
                onOpen={onOpen}
                onToggleSelect={onToggleSelect}
                onToggleFavorite={onToggleFavorite}
                onToggle={(enabled) => onToggle(server, enabled)}
                onEdit={onEdit}
                onClone={onClone}
                onExport={onExport}
                onDelete={onDelete}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
