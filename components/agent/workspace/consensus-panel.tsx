"use client"

/**
 * Consensus panel — workspace-side surface for active + recently resolved
 * consensus rows.
 *
 * Pulls data from `selectActiveTeamConsensus`; voting + manual resolution
 * dispatch through the consensus orchestrator so plugins listening on
 * `onConsensusVoted` / `onConsensusResolved` see the events.
 *
 * A vote is cast AS someone, so the panel has to know who. It used to read
 * `selectedTeammateId`, a field of the retired `/agent-teams/workspace` shell
 * whose only writers went with it — so the picker was empty, every vote button
 * was permanently disabled, and Coordination in `/agent-runs` could show a vote
 * it could never answer. The panel now offers the roster of the team it is
 * showing and defaults to that team's lead, which is who a human operator is
 * standing in for anyway.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useShallow } from "zustand/react/shallow"

import { VoteIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ConsensusRequest } from "@/types/agent/agent-team"
import type { AgentTeamState } from "@/stores/agent/agent-team-store/types"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import {
  selectActiveTeamConsensus,
  selectTeamConsensus,
  selectTeamTeammates,
} from "@/stores/agent/agent-team-store/selectors"
import {
  cancelConsensus,
  castVote,
  resolveConsensus,
} from "@/lib/ai/agent/team/consensus-orchestrator"
import { ConfirmActionDialog } from "./settings/confirm-action-dialog"

/** Lowest-index option leading the raw vote count. Ties fall to lowest index. */
function leadingOption(row: ConsensusRequest): number {
  let lead = 0
  let leadCount = -1
  for (let i = 0; i < row.options.length; i += 1) {
    const c = row.votes.filter((v) => v.optionIndex === i).length
    if (c > leadCount) {
      lead = i
      leadCount = c
    }
  }
  return lead
}

function statusVariant(
  status: ConsensusRequest["status"]
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "open":
      return "default"
    case "resolved":
      return "secondary"
    case "timeout":
      return "destructive"
    case "cancelled":
      return "outline"
    default:
      return "outline"
  }
}

export interface ConsensusPanelProps {
  /**
   * Which team's consensus to show.
   *
   * Omitted means "whichever team the store last selected", which is right
   * inside a workspace the user navigated into and wrong everywhere else. The
   * run cockpit shows one run at a time and never selects a team, so without
   * this it would render whatever the retired workspace last looked at.
   */
  teamId?: string
}

export function ConsensusPanel({ teamId }: ConsensusPanelProps = {}) {
  const t = useTranslations("agentTeamsWorkspace.consensus")
  const tConfirm = useTranslations("agentTeamsWorkspace.settings.confirm")
  // The selector materialises a new array each call, so `useShallow` makes the
  // subscriber bail out when the contents are reference-equal and the panel
  // does not re-render on every store update.
  const consensus = useAgentTeamStore(
    useShallow((state: AgentTeamState) =>
      teamId === undefined ? selectActiveTeamConsensus(state) : selectTeamConsensus(state, teamId)
    )
  )
  // The roster the votes are cast from. Resolved against the same team the
  // rows came from, with the store's last-created team as the only fallback —
  // the identical rule the consensus selector above follows.
  const roster = useAgentTeamStore(
    useShallow((state: AgentTeamState) =>
      selectTeamTeammates(state, teamId ?? state.activeTeamId ?? undefined)
    )
  )
  const leadId = useAgentTeamStore((state: AgentTeamState) =>
    teamId ? state.teams[teamId]?.leadId : undefined
  )

  const [voterOverride, setVoterOverride] = useState<string | null>(null)
  // Adjusted during render rather than in an effect: the roster can change
  // under the panel (a teammate is removed mid-run), and an effect would let
  // one paint show a voter who is no longer on the team.
  const defaultVoterId = roster.find((tm) => tm.id === leadId)?.id ?? roster[0]?.id
  const voterId =
    voterOverride && roster.some((tm) => tm.id === voterOverride) ? voterOverride : defaultVoterId

  const [pendingResolve, setPendingResolve] = useState<{ id: string; lead: number } | null>(null)

  const ordered = useMemo(
    () =>
      [...consensus].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ),
    [consensus]
  )

  return (
    <Card className="space-y-3 p-4" data-testid="consensus-panel">
      <p className="flex items-center gap-2 text-sm font-medium">
        <VoteIcon className="size-4 text-muted-foreground" aria-hidden />
        {t("title")}
      </p>
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      {/* Rendered, not hidden, when the roster is empty: "there is nobody to
          vote as" and "this panel has no voter concept" look identical once the
          control disappears, and the first is the one an operator can fix. */}
      <div className="flex items-center gap-2">
        <Label htmlFor="consensus-voter" className="shrink-0 text-xs text-muted-foreground">
          {t("voteAs")}
        </Label>
        <Select
          value={voterId ?? ""}
          onValueChange={setVoterOverride}
          disabled={roster.length === 0}
        >
          <SelectTrigger
            id="consensus-voter"
            className="h-8 w-56"
            data-testid="consensus-voter-picker"
          >
            <SelectValue placeholder={t("voteAsEmpty")} />
          </SelectTrigger>
          <SelectContent>
            {roster.map((tm) => (
              <SelectItem key={tm.id} value={tm.id}>
                {tm.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {ordered.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ScrollArea className="max-h-[420px] pr-1">
          <div className="space-y-3">
            {ordered.map((row) => (
              <div key={row.id} className="space-y-2 rounded-md border p-3 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">{row.question}</p>
                  <Badge variant={statusVariant(row.status)} className="text-[10px]">
                    {t(`status.${row.status}` as never)}
                  </Badge>
                </div>
                <p className="text-[10px] text-muted-foreground">{t("type", { type: row.type })}</p>
                <div className="space-y-1">
                  {row.options.map((option, idx) => {
                    const count = row.votes.filter((v) => v.optionIndex === idx).length
                    const isWinner = row.status === "resolved" && row.winningOption === idx
                    return (
                      <div
                        key={idx}
                        className="flex items-center justify-between rounded border px-2 py-1"
                      >
                        <span className={isWinner ? "font-medium text-primary" : ""}>
                          {idx + 1}. {option}
                        </span>
                        <div className="flex items-center gap-1">
                          <Badge variant="outline" className="text-[10px]">
                            {t("voteCount", { count })}
                          </Badge>
                          {row.status === "open" ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={!voterId}
                              title={voterId ? undefined : t("voteAsEmpty")}
                              onClick={() => {
                                if (!voterId) return
                                try {
                                  castVote({
                                    consensusId: row.id,
                                    voterId,
                                    optionIndex: idx,
                                  })
                                } catch (err) {
                                  console.warn("castVote failed:", err)
                                }
                              }}
                            >
                              {t("vote")}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    )
                  })}
                </div>
                {row.status === "open" ? (
                  <div className="flex items-center gap-2 pt-1">
                    {row.type === "lead_override" ? (
                      <Button
                        size="sm"
                        variant="default"
                        onClick={() => setPendingResolve({ id: row.id, lead: leadingOption(row) })}
                      >
                        {t("forceResolve")}
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => cancelConsensus(row.id)}>
                      {t("cancel")}
                    </Button>
                  </div>
                ) : null}
                {row.summary ? (
                  <p className="text-[10px] text-muted-foreground">{row.summary}</p>
                ) : null}
              </div>
            ))}
          </div>
        </ScrollArea>
      )}

      <ConfirmActionDialog
        open={pendingResolve !== null}
        onOpenChange={(open) => {
          if (!open) setPendingResolve(null)
        }}
        title={tConfirm("forceResolve.title")}
        description={tConfirm("forceResolve.description")}
        confirmLabel={tConfirm("confirmLabel")}
        cancelLabel={tConfirm("cancelLabel")}
        tone="warning"
        onConfirm={() => {
          if (pendingResolve) resolveConsensus(pendingResolve.id, pendingResolve.lead)
          setPendingResolve(null)
        }}
      />
    </Card>
  )
}
