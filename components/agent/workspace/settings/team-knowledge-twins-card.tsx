"use client"

/**
 * Workspace settings → team-level Employee Digital Twin knowledge sources
 * (ADR-0003 × ADR-0022). Selecting a twin here adds it to the team's
 * `knowledgeTwinIds`, which authorizes ANY teammate to consult it via the
 * `twin_knowledge_search` collaboration tool — even members not personally
 * bound to that twin. Member-bound twins are always queryable regardless.
 *
 * Eager-save through `updateTeamConfig`, matching the governance / ultracode
 * sections' write pattern (spread the existing config so nothing is dropped).
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { listTwins } from "@/lib/db/twins"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam } from "@/types/agent/agent-team"

export interface TeamKnowledgeTwinsCardProps {
  team: AgentTeam
}

export function TeamKnowledgeTwinsCard({ team }: TeamKnowledgeTwinsCardProps) {
  const t = useTranslations("agentTeamsWorkspace.settings.knowledgeTwins")
  const twinsRaw = useLiveQuery(() => listTwins({ includeArchived: false }), [])
  const twins = useMemo(() => twinsRaw ?? [], [twinsRaw])
  const updateTeamConfig = useAgentTeamStore((s) => s.updateTeamConfig)
  const selected = useMemo(
    () => new Set(team.config.knowledgeTwinIds ?? []),
    [team.config.knowledgeTwinIds]
  )

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    updateTeamConfig(team.id, {
      ...team.config,
      knowledgeTwinIds: next.size > 0 ? [...next] : undefined,
    })
  }

  return (
    <Card className="space-y-2 p-4" data-testid="team-knowledge-twins-card">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{t("title")}</p>
        <p className="text-[10px] text-muted-foreground">{t("hint")}</p>
      </div>
      {twins.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {twins.map((tw) => {
            const on = selected.has(tw.id)
            return (
              <button
                key={tw.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(tw.id)}
                className={cn(
                  "rounded-pill border px-2 py-0.5 text-[11px] transition-colors",
                  on
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-muted"
                )}
                data-testid={`knowledge-twin-${tw.id}`}
              >
                {tw.name}
              </button>
            )
          })}
        </div>
      )}
    </Card>
  )
}
