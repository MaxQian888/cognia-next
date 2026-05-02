"use client"

import { useTranslations } from "next-intl"
import { Card } from "@/components/ui/card"
import type { AgentTeamEvent } from "@/types/agent/agent-team"

export interface AgentTeamActivityProps {
  events: AgentTeamEvent[]
}

export function AgentTeamActivity({ events }: AgentTeamActivityProps) {
  const t = useTranslations("agentTeamsWorkspace.activity")
  if (events.length === 0) {
    return (
      <Card className="p-4 text-center text-xs text-muted-foreground" data-testid="activity-empty">
        {t("empty")}
      </Card>
    )
  }
  // Newest events first.
  const ordered = [...events].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  )
  return (
    <ul className="divide-y rounded-md border" data-testid="workspace-activity">
      {ordered.map((event, i) => (
        <li
          key={`${event.type}-${event.timestamp.toISOString?.() ?? i}`}
          className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
          data-testid={`activity-row-${i}`}
        >
          <span className="font-mono text-[11px] text-primary">{event.type}</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {new Date(event.timestamp).toISOString()}
          </span>
        </li>
      ))}
    </ul>
  )
}
