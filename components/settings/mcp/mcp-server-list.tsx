"use client"

import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"

import { cn } from "@/lib/utils"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import type { McpServer } from "@cognia/agent-config-types"
import { McpServerCard } from "./mcp-server-card"
import { groupServers, type McpGroupBy } from "./mcp-server-utils"

interface Props {
  servers: McpServer[]
  view: "grid" | "list"
  groupBy: McpGroupBy
  selection: Set<string>
  isFavorite: (id: string) => boolean
  onToggleSelect: (id: string) => void
  onToggleFavorite: (id: string) => void
  onToggle: (server: McpServer, enabled: boolean) => void | Promise<void>
  onEdit: (id: string) => void
  onClone: (server: McpServer) => void
  onDelete: (server: McpServer) => void
}

/**
 * Renders the filtered server list, grouped per `groupBy` (favorites floated
 * to the top of each section) and laid out as a responsive card grid or a
 * dense list. Group sections fade/stagger in via the shared motion tokens.
 */
export function McpServerList({
  servers,
  view,
  groupBy,
  selection,
  isFavorite,
  onToggleSelect,
  onToggleFavorite,
  onToggle,
  onEdit,
  onClone,
  onDelete,
}: Props) {
  const t = useTranslations("mcp.group")
  const reduce = useReducedMotion()
  const groups = groupServers(servers, groupBy, isFavorite)

  const containerClass =
    view === "grid"
      ? "grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3"
      : "flex flex-col gap-1.5"

  return (
    <div className="space-y-4" data-testid="mcp-server-list">
      {groups.map((group) => (
        <div key={group.id} className="space-y-2">
          {group.headerKind !== "none" && (
            <h3 className="px-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {group.headerKind === "transport" ? group.headerValue : t(group.headerValue)}{" "}
              <span className="text-muted-foreground/60">({group.servers.length})</span>
            </h3>
          )}
          <motion.div
            className={containerClass}
            variants={reduce ? undefined : STAGGER_CONTAINER}
            initial={reduce ? false : "initial"}
            animate="animate"
          >
            {group.servers.map((server) => (
              <motion.div
                key={server.id}
                variants={reduce ? undefined : STAGGER_CHILD}
                className={cn("min-w-0")}
              >
                <McpServerCard
                  server={server}
                  variant={view === "list" ? "row" : "card"}
                  selected={selection.has(server.id)}
                  favorite={isFavorite(server.id)}
                  onToggleSelect={onToggleSelect}
                  onToggleFavorite={onToggleFavorite}
                  onToggle={(enabled) => onToggle(server, enabled)}
                  onEdit={onEdit}
                  onClone={onClone}
                  onDelete={onDelete}
                />
              </motion.div>
            ))}
          </motion.div>
        </div>
      ))}
    </div>
  )
}
