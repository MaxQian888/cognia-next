"use client"

import { useMemo, useRef } from "react"
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
 * Keyboard: the rail is a real listbox. Tab enters it once (roving tabindex),
 * then Up/Down/Home/End move focus, and selection follows focus so the detail
 * half tracks the keyboard the same way it tracks a click. Grouping is a visual
 * split only — the arrow order is the flat rendered order, so a group header is
 * never a dead end.
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
  const containerRef = useRef<HTMLDivElement>(null)
  const groups = groupServers(servers, groupBy, isFavorite)

  /** Rendered order, flattened across groups — the order the arrows follow. */
  const order = useMemo(() => groups.flatMap((group) => group.servers.map((s) => s.id)), [groups])
  // Tab must land somewhere even before anything is selected (mobile opens no
  // detail pane), so the first row holds the tabstop when nothing is active.
  const rovingId = activeId && order.includes(activeId) ? activeId : (order[0] ?? null)

  const moveFocus = (currentId: string, delta: number | "first" | "last") => {
    const from = order.indexOf(currentId)
    if (from < 0) return
    const to =
      delta === "first"
        ? 0
        : delta === "last"
          ? order.length - 1
          : Math.min(order.length - 1, Math.max(0, from + delta))
    const nextId = order[to]
    if (!nextId || nextId === currentId) return
    onOpen(nextId)
    containerRef.current
      ?.querySelector<HTMLElement>(`[data-server-id="${CSS.escape(nextId)}"]`)
      ?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-server-id]")
    const currentId = target?.dataset.serverId
    if (!currentId) return
    const step =
      event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowUp"
          ? -1
          : event.key === "Home"
            ? ("first" as const)
            : event.key === "End"
              ? ("last" as const)
              : null
    if (step === null) return
    event.preventDefault()
    moveFocus(currentId, step)
  }

  return (
    <div
      ref={containerRef}
      className="space-y-3"
      role="listbox"
      aria-orientation="vertical"
      onKeyDown={onKeyDown}
      data-testid="mcp-server-list"
    >
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
                tabIndex={server.id === rovingId ? 0 : -1}
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
