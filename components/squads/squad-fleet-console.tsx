"use client"

/**
 * The Squad fleet: what every Squad is doing right now, and the controls that
 * act on several at once.
 *
 * Deliberately runtime-only. Everything about *configuring* a Squad, its
 * name, its roster, its governance, lives in Settings, where the other
 * cross-conversation assets live. The page this replaces carried both, plus a
 * chat tab and a kanban board, and could not be read as any one thing.
 *
 * The board is back, and it is not a contradiction of that. A Squad's task
 * board is what the Squad is DOING, on the same axis as the run list beside
 * it, and it carries two plugin slots (`agent.team.task.actions`,
 * `agent.team.board.toolbar`) whose declared host stopped being rendered when
 * ADR-0140 retired `/agent-teams/workspace`. It is not folded into `/issues`:
 * both boards' headers record that crossing their two guard vocabularies (six
 * statuses against eight, `blocked` machine-only in one of them) was avoided on
 * purpose.
 *
 * Uses `FeaturePageShell` like `/issues` and `/servers`, which brings the
 * resizable panes with it rather than hand-rolling a third layout.
 *
 * This is the WIDE-PANE surface only. It used to branch on `useIsMobile()`
 * internally and fold both panes into an extra tab, which made one component
 * responsible for two layouts and left the phone with the rail rows a rail was
 * sized for. `/squads` was the only `FeaturePageShell` console doing that, and
 * the only route skipping the repo's `useCompactLayout()` switch. The phone now
 * has its own body, and the list and the inspector are shared components rather
 * than two branches of one file.
 */

import { useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { ActivityIcon, SettingsIcon, UsersIcon } from "lucide-react"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { AgentRunsPanel } from "@/components/agent-runs/agent-runs-panel"
import { AgentTeamTasks } from "@/components/agent/workspace/tasks"
import { SquadListPane } from "@/components/squads/squad-list-pane"
import { SquadInspector } from "@/components/squads/squad-inspector"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useFleetSnapshot } from "@/hooks/fleet/use-fleet-snapshot"
import { useSquadFleet } from "@/hooks/squads/use-squad-fleet"
import { useCreateSquad } from "@/hooks/squads/use-create-squad"
import type { SquadRouteState } from "@/hooks/squads/use-squad-route-state"
import { settingsHref } from "@/lib/settings/deep-link"

export interface SquadFleetConsoleProps {
  /**
   * The URL state, owned by the route and shared with the phone body, so a
   * link opens the same Squad and the same narrowed list on either.
   */
  route: SquadRouteState
}

/** The wide-pane tabs. `squads` is the phone's, and never has a trigger here. */
type ConsoleTab = "runs" | "board"

export function SquadFleetConsole({ route }: SquadFleetConsoleProps) {
  const t = useTranslations("squads.fleet")
  const tasks = useAgentTeamStore((s) => s.tasks)
  const teammates = useAgentTeamStore((s) => s.teammates)
  const fleet = useSquadFleet({ query: route.query, filter: route.filter })
  const createSquad = useCreateSquad()
  // `/fleet` is the live triage read of the HOST's sessions, where a parked
  // permission can be answered remotely. Its contract is `standalone: "hidden"`
  // and `companion: "remote"`, so the link is offered only where the route
  // exists: `source === "none"` is an unpaired browser, and pointing it at a
  // hidden route would be a dead end.
  const { source: fleetSource } = useFleetSnapshot()

  // The rail is already on screen here, so a wide pane opens on the runs
  // console. `squads` is the phone's tab, and asking for it from a shared link
  // or after a resize must not select a tab with no trigger and no content.
  const tab: ConsoleTab = route.tab === "board" ? "board" : "runs"

  // Read from the URL, not from the narrowed list. A filter is about the list,
  // not about what you were reading, so narrowing a selected Squad out of view
  // must not also close its inspector and blank its board.
  const inspectorId = route.selectedId

  // The board is per-Squad, so it needs a selection the way the inspector
  // does. Empty until one is made, rather than a board of everything, which
  // would mix two Squads' `blocked` columns into one meaningless lane.
  const selectedTasks = useMemo(
    () =>
      inspectorId ? Object.values(tasks ?? {}).filter((task) => task.teamId === inspectorId) : [],
    [tasks, inspectorId]
  )
  const selectedMembers = useMemo(
    () =>
      inspectorId ? Object.values(teammates).filter((member) => member.teamId === inspectorId) : [],
    [teammates, inspectorId]
  )

  const onCreate = useCallback(() => {
    void createSquad({ name: t("newSquadName"), leadName: t("defaultLeadName") }).then((squad) =>
      route.setSelectedId(squad.id)
    )
  }, [createSquad, route, t])

  return (
    <FeaturePageShell
      storageId="squads"
      header={
        <FeaturePageHeader
          variant="management"
          icon={<UsersIcon className="size-4" />}
          title={t("title")}
          description={t("description")}
          summary={t("summary", { total: fleet.total, live: fleet.live })}
          primaryAction={{
            id: "manage",
            label: t("manageAction"),
            icon: SettingsIcon,
            href: settingsHref("squads"),
          }}
          secondaryActions={
            fleetSource === "none"
              ? []
              : [
                  {
                    id: "fleet",
                    label: t("openFleet"),
                    icon: ActivityIcon,
                    href: "/fleet",
                    testId: "squad-fleet-host-activity",
                  },
                ]
          }
        />
      }
      leftPane={{
        label: t("railLabel"),
        content: <SquadListPane fleet={fleet} route={route} onCreate={onCreate} />,
        // Wider than the shell's 18% default. A row here carries a name AND a
        // status badge, and the badge is `shrink-0`, so at the default the name
        // is what gives way: on an 800px pane with the inspector open the rail
        // rendered "R" and "Tri…". A list you cannot read the names in is not a
        // list.
        defaultSize: 24,
        minSize: 16,
      }}
      {...(inspectorId
        ? {
            rightPane: {
              label: t("inspectorLabel"),
              content: <SquadInspector squadId={inspectorId} />,
            },
          }
        : {})}
      centerClassName="min-h-0"
    >
      {/* Controlled, not `defaultValue`. This page re-renders on every live
          status change, and an uncontrolled Radix tab loses its selection
          whenever its subtree is remounted, snapping the reader back to Runs
          mid-read. Owning the value here makes the choice survive. */}
      <Tabs
        value={tab}
        onValueChange={(next) => route.setTab(next as ConsoleTab)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList className="mx-4 mt-3 w-fit shrink-0">
          <TabsTrigger value="runs" data-testid="squad-fleet-tab-runs">
            {t("tabs.runs")}
          </TabsTrigger>
          <TabsTrigger value="board" data-testid="squad-fleet-tab-board">
            {t("tabs.board")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="runs" className="min-h-0 flex-1 overflow-hidden">
          {/* The canonical run cockpit, pinned to Squad runs and, when one is
              selected, to that Squad (ADR-0169). Same rows, same detail pane,
              same `allowedActions` as `/agent-runs`; `?run=` deep-links share
              the id space, so a card's `/agent-runs?run=…` opens the same run. */}
          <AgentRunsPanel
            embedded
            filterKind="team"
            {...(inspectorId ? { teamId: inspectorId } : {})}
            selectedId={route.runId}
            onSelect={(id) => route.setRunId(id ?? undefined)}
          />
        </TabsContent>
        <TabsContent value="board" className="min-h-0 flex-1 overflow-y-auto p-4">
          {inspectorId ? (
            <AgentTeamTasks
              teamId={inspectorId}
              tasks={selectedTasks}
              teammates={selectedMembers}
            />
          ) : (
            <Empty className="py-10" data-testid="squad-fleet-board-unselected">
              <EmptyMedia variant="icon">
                <UsersIcon />
              </EmptyMedia>
              <EmptyTitle className="text-sm">{t("boardUnselectedTitle")}</EmptyTitle>
              <EmptyDescription className="text-xs">
                {t("boardUnselectedDescription")}
              </EmptyDescription>
            </Empty>
          )}
        </TabsContent>
      </Tabs>
    </FeaturePageShell>
  )
}

export default SquadFleetConsole
