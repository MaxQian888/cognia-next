"use client"

import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { ActivityIcon } from "lucide-react"

import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { StatusBadge } from "@/components/status-badge"
import type { AgentTeamEvent } from "@/types/agent/agent-team"

export interface AgentTeamActivityProps {
  events: AgentTeamEvent[]
}

export function AgentTeamActivity({ events }: AgentTeamActivityProps) {
  const t = useTranslations("agentTeamsWorkspace.activity")
  const prefersReducedMotion = useReducedMotion()

  if (events.length === 0) {
    return (
      <Empty data-testid="activity-empty">
        <EmptyMedia variant="icon">
          <ActivityIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>{t("empty")}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  }

  // Newest events first.
  const ordered = [...events].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  )

  return (
    <ScrollArea className="max-h-[60vh] rounded-md border">
      <ul className="divide-y" data-testid="workspace-activity">
        {ordered.map((event, i) => (
          <motion.li
            key={`${event.type}-${event.timestamp.toISOString?.() ?? i}`}
            initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: 0.15,
              ease: "easeOut",
              delay: prefersReducedMotion ? 0 : Math.min(i * 0.025, 0.12),
            }}
            className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
            data-testid={`activity-row-${i}`}
          >
            <StatusBadge
              value={event.type}
              labelNamespace="agentTeamsWorkspace.activity.eventKind"
              className="text-[11px] font-mono"
            />
            <span className="font-mono text-[10px] text-muted-foreground">
              {new Date(event.timestamp).toISOString()}
            </span>
          </motion.li>
        ))}
      </ul>
    </ScrollArea>
  )
}
