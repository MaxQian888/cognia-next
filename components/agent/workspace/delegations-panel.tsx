"use client"

/**
 * Delegations panel — workspace-side surface for active + recently settled
 * team delegations (background / external / team handoffs).
 *
 * Mirrors {@link ConsensusPanel}: rows come from `selectTeamDelegations` for
 * the team this panel was opened for; approve / cancel dispatch through the
 * delegation orchestrator so plugins listening on `onTeamDelegationComplete`
 * see the events. Without this surface the delegation runtime (which teammates
 * can drive via the `team_delegate` tool) had no operator-facing view — a
 * delegation stuck in `awaiting_approval` (e.g. inside quiet hours) could never
 * be released.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { useShallow } from "zustand/react/shallow"

import { SendIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { TeamDelegationRecord, TeamDelegationStatus } from "@/types/agent/agent-team"
import type { AgentTeamState } from "@/stores/agent/agent-team-store/types"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { selectTeamDelegations } from "@/stores/agent/agent-team-store/selectors"
import { approveDelegation, cancelDelegation } from "@/lib/ai/agent/team/delegation-orchestrator"

function statusVariant(
  status: TeamDelegationStatus
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "active":
    case "pending":
      return "default"
    case "awaiting_approval":
      return "outline"
    case "completed":
      return "secondary"
    case "failed":
    case "timeout":
      return "destructive"
    case "cancelled":
      return "outline"
    default:
      return "outline"
  }
}

export interface DelegationsPanelProps {
  /**
   * Which team's delegations to show. See `ConsensusPanelProps.teamId`.
   *
   * Omitted means "whichever team the store last selected", which only
   * `createTeam` writes and persist does not carry — so it is right inside a
   * surface the user just created a squad from and empty after a reload. Every
   * real caller names its team.
   */
  teamId?: string
}

export function DelegationsPanel({ teamId }: DelegationsPanelProps = {}) {
  const t = useTranslations("agentTeamsWorkspace.delegations")
  // The selector materialises a fresh array, so `useShallow` bails out when the
  // contents are reference-equal and the panel does not churn. One selector,
  // one fallback rule — the same `teamId ?? activeTeamId` resolution the
  // consensus panel's roster follows, so a named team and an unnamed one
  // cannot drift apart.
  const delegations = useAgentTeamStore(
    useShallow((state: AgentTeamState) =>
      selectTeamDelegations(state, teamId ?? state.activeTeamId ?? undefined)
    )
  )

  const ordered = useMemo(
    () =>
      [...delegations].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ),
    [delegations]
  )

  const isPending = (status: TeamDelegationStatus): boolean =>
    status === "active" || status === "awaiting_approval" || status === "pending"

  return (
    <Card className="space-y-3 p-4" data-testid="delegations-panel">
      <p className="flex items-center gap-2 text-sm font-medium">
        <SendIcon className="size-4 text-muted-foreground" aria-hidden />
        {t("title")}
      </p>
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      {ordered.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ScrollArea className="max-h-[420px] pr-1">
          <div className="space-y-3">
            {ordered.map((row: TeamDelegationRecord) => (
              <div key={row.id} className="space-y-2 rounded-md border p-3 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">{row.reason}</p>
                  <Badge variant={statusVariant(row.status)} className="text-[10px]">
                    {t(`status.${row.status}` as never)}
                  </Badge>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {t("target", { type: row.targetType, id: row.targetId ?? "—" })}
                </p>
                {row.error ? <p className="text-[10px] text-destructive">{row.error}</p> : null}
                {isPending(row.status) ? (
                  <div className="flex justify-end gap-2">
                    {row.status === "awaiting_approval" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => approveDelegation(row.id)}
                      >
                        {t("approve")}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => cancelDelegation(row.id)}
                    >
                      {t("cancel")}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </Card>
  )
}
