"use client"

/**
 * A selected Squad's own view: its masthead, then Overview / Runs / Board.
 *
 * Written once for the wide pane's centre and the phone's full screen. The two
 * used to answer "this Squad" differently: the desktop narrowed its runs list
 * and opened a fourth column, the phone opened a drawer over the list while
 * its Runs and Board tabs went on being silently scoped to a Squad the reader
 * could no longer see. Now selecting a Squad means the same thing on both:
 * you are in that Squad, its name and controls are at the top, and every tab
 * below belongs to it.
 *
 * Runs is the canonical cockpit pinned to this Squad (ADR-0169), with its own
 * list/detail split, which now gets the whole centre instead of sharing it with
 * an inspector. Reviews are answered there, in the run detail, so every "Needs
 * you" on this page is a link into this tab with the run open.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { AgentRunsPanel } from "@/components/agent-runs/agent-runs-panel"
import { AgentTeamTasks } from "@/components/agent/workspace/tasks"
import { SquadMasthead } from "@/components/squads/squad-masthead"
import { SquadOverview } from "@/components/squads/squad-overview"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { usePendingSquadReviews } from "@/hooks/squads/use-pending-squad-reviews"
import {
  SQUAD_DETAIL_TABS,
  type SquadDetailTab,
  type SquadRouteState,
} from "@/hooks/squads/use-squad-route-state"
import { useSquadRunControl } from "@/hooks/squads/use-squad-run-control"
import { cn } from "@/lib/utils"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

export interface SquadDetailViewProps {
  squadId: string
  route: SquadRouteState
  /** The tab to show, already resolved by the host (`resolveSquadTab`). */
  tab: SquadDetailTab
  /** Where the view replaces the list (a phone): the way back to it. */
  onBack?: () => void
  /** Phone layout: full-width tabs, and the runs cockpit in its compact form. */
  compact?: boolean
  className?: string
}

const DONE_TASK_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"])

export function SquadDetailView(props: SquadDetailViewProps) {
  // Keyed on the Squad: a start attempt, a refusal and a busy flag belong to
  // the Squad they were made on, and must not carry over to the next one.
  return <SquadDetailViewContent key={props.squadId} {...props} />
}

function SquadDetailViewContent({
  squadId,
  route,
  tab,
  onBack,
  compact = false,
  className,
}: SquadDetailViewProps) {
  const t = useTranslations("squads.fleet")
  const squad = useAgentTeamStore((s) => s.teams[squadId])
  const teammates = useAgentTeamStore((s) => s.teammates)
  const allTasks = useAgentTeamStore((s) => s.tasks)
  const control = useSquadRunControl(squadId)
  const allReviews = usePendingSquadReviews()

  const members = useMemo(
    () => Object.values(teammates).filter((member) => member.teamId === squadId),
    [teammates, squadId]
  )
  const tasks = useMemo(
    () => Object.values(allTasks ?? {}).filter((task) => task.teamId === squadId),
    [allTasks, squadId]
  )
  const reviews = useMemo(
    () => allReviews.filter((review) => review.teamId === squadId),
    [allReviews, squadId]
  )
  const openTasks = tasks.filter((task) => !DONE_TASK_STATUSES.has(task.status)).length

  if (!squad) return null

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)} data-testid="squad-detail-view">
      <SquadMasthead
        squad={squad}
        memberCount={members.length}
        waitingCount={reviews.length}
        control={control}
        {...(onBack ? { onBack } : {})}
      />
      {/* Controlled, not `defaultValue`. This view re-renders on every live
          status change, and an uncontrolled Radix tab loses its selection
          whenever its subtree is remounted, snapping the reader back mid-read.
          The value lives in the URL, so a link opens the same tab. */}
      <Tabs
        value={tab}
        onValueChange={(next) => route.setTab(next as SquadDetailTab)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList
          className={cn("mx-4 mt-3 shrink-0", compact ? "grid w-auto grid-cols-3" : "w-fit")}
        >
          {SQUAD_DETAIL_TABS.map((value) => (
            <TabsTrigger
              key={value}
              value={value}
              className="gap-1.5"
              data-testid={`squad-detail-tab-${value}`}
            >
              {t(`tabs.${value}`)}
              {value === "runs" && reviews.length > 0 ? (
                <span
                  className="rounded-full bg-destructive px-1.5 text-[10px] font-semibold tabular-nums text-destructive-foreground"
                  aria-label={t("detail.waitingCount", { count: reviews.length })}
                >
                  {reviews.length}
                </span>
              ) : null}
              {value === "board" && openTasks > 0 ? (
                <span
                  className="text-[11px] tabular-nums text-muted-foreground"
                  aria-label={t("detail.openTasks", { count: openTasks })}
                >
                  {openTasks}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto p-4">
          <SquadOverview
            squad={squad}
            members={members}
            tasks={tasks}
            reviews={reviews}
            control={control}
            runHref={route.runHref}
            onOpenBoard={() => route.setTab("board")}
            className={cn(!compact && "max-w-5xl")}
          />
        </TabsContent>
        <TabsContent value="runs" className="mt-3 min-h-0 flex-1 overflow-hidden border-t">
          {/* The canonical run cockpit, pinned to Squad runs and to this Squad
              (ADR-0169). Same rows, same detail pane, same `allowedActions` as
              `/agent-runs`; `?run=` deep-links share the id space. */}
          <AgentRunsPanel
            embedded
            filterKind="team"
            teamId={squadId}
            selectedId={route.runId}
            onSelect={(id) => route.setRunId(id ?? undefined)}
            statusGroup={route.runStatus}
            onStatusGroup={route.setRunStatus}
            {...(compact ? { compact: true } : {})}
          />
        </TabsContent>
        <TabsContent value="board" className="min-h-0 flex-1 overflow-y-auto p-4">
          <AgentTeamTasks teamId={squadId} tasks={tasks} teammates={members} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default SquadDetailView
