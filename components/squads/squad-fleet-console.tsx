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
 * resizable panes and the below-768px Sheet fallback with it rather than
 * hand-rolling a third layout.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { ExternalLinkIcon, SettingsIcon, UsersIcon } from "lucide-react"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import { ScrollArea } from "@/components/ui/scroll-area"
import { StatusBadge } from "@/components/status-badge"
import { AgentTeamCommandCenter } from "@/components/agent/team/command-center"
import { AgentTeamTasks } from "@/components/agent/workspace/tasks"
import { TeamRunControls } from "@/components/agent/workspace/team-run-controls"
import { agentTeamManager } from "@/lib/ai/agent/agent-team"
import { TeamRunsList } from "@/components/agent/team/runs-list"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { settingsHref } from "@/lib/settings/deep-link"
import { squadPanelId } from "@/components/settings/squads/nav-config"
import { cn } from "@/lib/utils"

/** Statuses that mean "this Squad is doing something right now". */
const LIVE_TEAM_STATUSES = new Set(["planning", "executing"])

export interface SquadFleetConsoleProps {
  /** From `?id=` — deep links survive a static export this way. */
  selectedId?: string
  onSelect: (squadId: string | null) => void
}

export function SquadFleetConsole({ selectedId, onSelect }: SquadFleetConsoleProps) {
  const t = useTranslations("squads.fleet")
  const teams = useAgentTeamStore((s) => s.teams)
  const teammates = useAgentTeamStore((s) => s.teammates)
  const tasks = useAgentTeamStore((s) => s.tasks)

  const squads = useMemo(
    () =>
      Object.values(teams)
        .map((team) => ({
          id: team.id,
          name: team.name,
          description: team.description,
          status: team.status,
          memberCount: Object.values(teammates).filter((m) => m.teamId === team.id).length,
        }))
        // Working Squads first, then by name — a fleet view is read for what
        // is happening, not alphabetically.
        .sort((a, b) => {
          const aLive = LIVE_TEAM_STATUSES.has(a.status) ? 0 : 1
          const bLive = LIVE_TEAM_STATUSES.has(b.status) ? 0 : 1
          return aLive - bLive || a.name.localeCompare(b.name)
        }),
    [teams, teammates]
  )

  const liveCount = squads.filter((s) => LIVE_TEAM_STATUSES.has(s.status)).length
  const selected = selectedId ? teams[selectedId] : undefined

  // The board is per-Squad, so it needs a selection the way the inspector
  // does. Empty until one is made, rather than a board of everything, which
  // would mix two Squads' `blocked` columns into one meaningless lane.
  const selectedTasks = useMemo(
    () =>
      selectedId ? Object.values(tasks ?? {}).filter((task) => task.teamId === selectedId) : [],
    [tasks, selectedId]
  )
  const selectedMembers = useMemo(
    () =>
      selectedId ? Object.values(teammates).filter((member) => member.teamId === selectedId) : [],
    [teammates, selectedId]
  )

  const rail = (
    <div className="flex h-full min-h-0 flex-col" data-testid="squad-fleet-rail">
      <ScrollArea className="min-h-0 flex-1">
        {squads.length === 0 ? (
          <Empty className="py-10" data-testid="squad-fleet-empty">
            <EmptyMedia variant="icon">
              <UsersIcon />
            </EmptyMedia>
            <EmptyTitle className="text-sm">{t("emptyTitle")}</EmptyTitle>
            <EmptyDescription className="text-xs">{t("emptyDescription")}</EmptyDescription>
          </Empty>
        ) : (
          <div className="p-1.5" role="list">
            {squads.map((squad) => (
              <button
                key={squad.id}
                type="button"
                role="listitem"
                aria-current={squad.id === selectedId ? "true" : undefined}
                onClick={() => onSelect(squad.id === selectedId ? null : squad.id)}
                data-testid="squad-fleet-row"
                className={cn(
                  "w-full rounded-sm text-left hover:bg-accent",
                  squad.id === selectedId && "bg-accent"
                )}
              >
                <Item size="sm">
                  <ItemMedia>
                    <span
                      aria-hidden
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        LIVE_TEAM_STATUSES.has(squad.status)
                          ? "animate-pulse bg-emerald-500"
                          : "bg-muted-foreground/40"
                      )}
                    />
                  </ItemMedia>
                  <ItemContent className="min-w-0 gap-0.5">
                    <ItemTitle className="block w-full min-w-0 truncate text-xs">
                      {squad.name}
                    </ItemTitle>
                    <ItemDescription className="truncate text-[10px]">
                      {t("memberCount", { count: squad.memberCount })}
                    </ItemDescription>
                  </ItemContent>
                  <StatusBadge
                    value={squad.status}
                    labelNamespace="agentTeam.status"
                    className="shrink-0 text-[10px]"
                    pulse={LIVE_TEAM_STATUSES.has(squad.status)}
                  />
                </Item>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )

  const inspector = selected ? (
    <div className="flex h-full min-h-0 flex-col" data-testid="squad-fleet-inspector">
      <div className="shrink-0 space-y-1 border-b p-3">
        <p className="truncate text-sm font-medium">{selected.name}</p>
        {selected.description ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{selected.description}</p>
        ) : null}
        {/* Start, pause, resume, stop. Without them a fleet console could say
            what every Squad was doing and do nothing about any of it, and these
            controls only ever existed on a tab of the retired
            `/agent-teams/workspace`. Acting on a run is runtime, not
            configuration, so this is the page for it.

            Fire-and-forget: every one of these settles at terminal state and
            the row's own status is what reports back. */}
        <TeamRunControls
          status={selected.status}
          ultracodeEnabled={selected.config?.ultracode?.enabled}
          onStart={() => void agentTeamManager.start(selected.id).catch(() => undefined)}
          onStartUltracode={() =>
            void agentTeamManager.start(selected.id, { ultracode: true }).catch(() => undefined)
          }
          onPause={() => void agentTeamManager.pause(selected.id).catch(() => undefined)}
          onAbort={() => void agentTeamManager.pause(selected.id).catch(() => undefined)}
          onResume={() => void agentTeamManager.resume(selected.id).catch(() => undefined)}
          onStop={() => void agentTeamManager.shutdown(selected.id).catch(() => undefined)}
          className="pt-1"
        />
        <Link
          href={settingsHref("squads", { params: { squadTab: squadPanelId(selected.id) } })}
          className="inline-flex items-center gap-1 pt-1 text-xs text-muted-foreground hover:text-foreground"
          data-testid="squad-fleet-configure"
        >
          <SettingsIcon aria-hidden className="size-3" />
          {/* Configuration is not on this page on purpose: one place per
              question, and this page answers "what is running". */}
          {t("configure")}
          <ExternalLinkIcon aria-hidden className="size-3" />
        </Link>
      </div>
      <ScrollArea className="min-h-0 flex-1 p-3">
        <TeamRunsList teamId={selected.id} />
      </ScrollArea>
    </div>
  ) : null

  return (
    <FeaturePageShell
      storageId="squads"
      header={
        <FeaturePageHeader
          variant="management"
          icon={<UsersIcon className="size-4" />}
          title={t("title")}
          description={t("description")}
          summary={t("summary", { total: squads.length, live: liveCount })}
          primaryAction={{
            id: "manage",
            label: t("manageAction"),
            icon: SettingsIcon,
            href: settingsHref("squads"),
          }}
        />
      }
      leftPane={{ label: t("railLabel"), content: rail }}
      {...(inspector ? { rightPane: { label: t("inspectorLabel"), content: inspector } } : {})}
      centerClassName="min-h-0"
    >
      <Tabs defaultValue="runs" className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="mx-4 mt-3 w-fit shrink-0">
          <TabsTrigger value="runs" data-testid="squad-fleet-tab-runs">
            {t("tabs.runs")}
          </TabsTrigger>
          <TabsTrigger value="board" data-testid="squad-fleet-tab-board">
            {t("tabs.board")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="runs" className="min-h-0 flex-1 overflow-y-auto p-4">
          <AgentTeamCommandCenter heading={false} />
        </TabsContent>
        <TabsContent value="board" className="min-h-0 flex-1 overflow-y-auto p-4">
          {selected ? (
            <AgentTeamTasks
              teamId={selected.id}
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
