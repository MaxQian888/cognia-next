"use client"

/**
 * The Squad running THIS conversation.
 *
 * Replaces a panel that showed whichever Squad the old workspace page
 * happened to have selected — global state, in a rail whose every other panel
 * follows the resource you are looking at. It also linked to `/agent-team`, a
 * route that does not exist, so its one action 404'd.
 *
 * Conversation-scoped, and deliberately read-only: this answers "who is on
 * this, and what is it waiting for", not "change it". Changing the executor is
 * the composer's job, one control, in the place you are already typing.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { UsersIcon, ShieldAlertIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { ScrollArea } from "@/components/ui/scroll-area"
import { StatusBadge } from "@/components/status-badge"
import { useChatExecutor } from "@/components/agent/composition/use-chat-executor"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import type { TeammateStatus } from "@/types/agent/agent-team"
import { cn } from "@/lib/utils"

export const SQUAD_CONTEXT_PANEL_ID = "squad-context"

/** Only the two that mean "working right now" get a live dot. */
const LIVE_STATUSES: ReadonlySet<TeammateStatus> = new Set<TeammateStatus>([
  "executing",
  "planning",
])

const STATUS_DOT: Record<TeammateStatus, string> = {
  idle: "bg-muted-foreground/40",
  planning: "bg-blue-500",
  awaiting_approval: "bg-yellow-500",
  executing: "bg-emerald-500",
  paused: "bg-orange-500",
  completed: "bg-emerald-600",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/50",
  shutdown: "bg-muted-foreground/30",
}

export interface SquadContextPanelProps {
  /** The conversation this panel follows. */
  sessionId: string | null
}

export function SquadContextPanel({ sessionId }: SquadContextPanelProps) {
  const t = useTranslations("contextWorkbench.squadPanel")
  const executor = useChatExecutor(sessionId ?? undefined)
  const teammatesRecord = useAgentTeamStore((s) => s.teammates)
  const gates = usePendingGatesStore((s) => s.gates)
  const squadId = executor.squadId

  // Derived in a memo, not in the selector: mapping inside a zustand selector
  // returns a fresh array every render and loops forever.
  const members = useMemo(
    () =>
      squadId
        ? Object.values(teammatesRecord)
            .filter((m) => m.teamId === squadId)
            .sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [teammatesRecord, squadId]
  )
  const liveCount = members.filter((m) => LIVE_STATUSES.has(m.status)).length
  const openGates = useMemo(
    () => (squadId ? gates.filter((g) => g.teamId === squadId) : []),
    [gates, squadId]
  )

  if (!squadId) {
    return (
      <Empty className="h-full rounded-none" data-testid="squad-panel-unbound">
        <EmptyMedia variant="icon">
          <UsersIcon />
        </EmptyMedia>
        <EmptyTitle className="text-sm">{t("unboundTitle")}</EmptyTitle>
        {/* Names where to change it rather than offering a second control for
            the same decision. */}
        <EmptyDescription className="text-xs">{t("unboundDescription")}</EmptyDescription>
      </Empty>
    )
  }

  if (!executor.squadName) {
    return (
      <Empty className="h-full rounded-none" data-testid="squad-panel-missing">
        <EmptyMedia variant="icon">
          <UsersIcon />
        </EmptyMedia>
        <EmptyTitle className="text-sm">{t("missingTitle")}</EmptyTitle>
        <EmptyDescription className="text-xs">{t("missingDescription")}</EmptyDescription>
      </Empty>
    )
  }

  return (
    <div className="flex h-full flex-col" data-testid="squad-panel">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <UsersIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{executor.squadName}</span>
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {t("working", { count: liveCount })}
        </Badge>
      </div>

      {openGates.length > 0 ? (
        // The dialog is app-root mounted and answerable anywhere; this is the
        // conversation's own "you are being asked something" marker, so the
        // panel does not look idle while the run is blocked.
        <div
          className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-3 py-2 text-xs"
          data-testid="squad-panel-gates"
        >
          <ShieldAlertIcon aria-hidden className="size-3.5 shrink-0 text-amber-600" />
          <span className="min-w-0 flex-1 truncate">
            {t("awaitingYou", { count: openGates.length })}
          </span>
        </div>
      ) : null}

      <ScrollArea className="flex-1">
        {members.length === 0 ? (
          <Empty className="h-32 rounded-none" data-testid="squad-panel-no-members">
            <EmptyTitle className="text-sm">{t("noMembersTitle")}</EmptyTitle>
            <EmptyDescription className="text-xs">{t("noMembersDescription")}</EmptyDescription>
          </Empty>
        ) : (
          <div className="divide-y">
            {members.map((member) => (
              <Item key={member.id} size="sm" data-testid="squad-panel-member">
                <ItemMedia>
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      STATUS_DOT[member.status],
                      LIVE_STATUSES.has(member.status) && "animate-pulse"
                    )}
                  />
                </ItemMedia>
                <ItemContent className="min-w-0 gap-0.5">
                  <ItemTitle className="truncate text-xs">{member.name}</ItemTitle>
                  {member.lastActivity ? (
                    <ItemDescription className="truncate text-[10px]">
                      {member.lastActivity}
                    </ItemDescription>
                  ) : null}
                </ItemContent>
                <StatusBadge
                  value={member.status}
                  labelNamespace="agentTeam.status"
                  className="shrink-0 text-[10px]"
                  pulse={LIVE_STATUSES.has(member.status)}
                />
              </Item>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

export default SquadContextPanel
