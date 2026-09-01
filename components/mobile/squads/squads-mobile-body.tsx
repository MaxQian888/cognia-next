"use client"

/**
 * `/squads` on a phone.
 *
 * `FeaturePageShell` does have a mobile branch, but it collapses the left pane
 * into a Sheet behind an unlabelled glyph. For a fleet console that is
 * backwards: the list is not a sidebar here, it is the page, and the detail is
 * what should arrive on demand. `/squads` was the last such console still
 * answering a phone from inside the desktop component, on a `useIsMobile()`
 * branch, which is why it was also the only route in the repo skipping the
 * `useCompactLayout()` switch every peer subsystem goes through.
 *
 * Nothing about a Squad is re-modelled here. `SquadListPane` is the same
 * component the desktop rail renders, `SquadInspector` is the same detail,
 * `AgentTeamCommandCenter` and `AgentTeamTasks` are reused verbatim (both are
 * already phone-aware), and everything reads the same `useSquadFleet`
 * projection, so a row can never say one thing here and another on a desktop.
 *
 * The board tab renders the list when nothing is selected. On a phone that IS
 * the answer to "pick a Squad". The previous empty state told the reader to use
 * a rail that lived in a different tab, which is a dead end with a helpful
 * tone.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { SettingsIcon } from "lucide-react"

import { AgentTeamCommandCenter } from "@/components/agent/team/command-center"
import { AgentTeamTasks } from "@/components/agent/workspace/tasks"
import { TeamRunsList } from "@/components/agent/team/runs-list"
import { ResponsiveDetailSheet } from "@/components/shared/responsive-detail-sheet"
import { SquadInspector } from "@/components/squads/squad-inspector"
import { SquadListPane } from "@/components/squads/squad-list-pane"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useCreateSquad } from "@/hooks/squads/use-create-squad"
import { useSquadFleet } from "@/hooks/squads/use-squad-fleet"
import type { SquadFleetTab, SquadRouteState } from "@/hooks/squads/use-squad-route-state"
import { settingsHref } from "@/lib/settings/deep-link"

export interface SquadsMobileBodyProps {
  route: SquadRouteState
}

export function SquadsMobileBody({ route }: SquadsMobileBodyProps) {
  const t = useTranslations("squads.fleet")
  const fleet = useSquadFleet({ query: route.query, filter: route.filter })
  const teams = useAgentTeamStore((s) => s.teams)
  const tasks = useAgentTeamStore((s) => s.tasks)
  const teammates = useAgentTeamStore((s) => s.teammates)
  const createSquad = useCreateSquad()

  // A phone opens on the Squads themselves. Landing it on "no durable runs
  // match these filters" would be the page answering a question nobody asked
  // while withholding the one they did.
  const tab: SquadFleetTab = route.tab ?? "squads"
  const selectedId = route.selectedId
  const selected = selectedId ? teams[selectedId] : undefined

  const onCreate = useCallback(() => {
    void createSquad({ name: t("newSquadName"), leadName: t("defaultLeadName") }).then((squad) =>
      route.setSelectedId(squad.id)
    )
  }, [createSquad, route, t])

  const selectedTasks = selectedId
    ? Object.values(tasks ?? {}).filter((task) => task.teamId === selectedId)
    : []
  const selectedMembers = selectedId
    ? Object.values(teammates).filter((member) => member.teamId === selectedId)
    : []

  return (
    // The shell owns `data-bg-target` for every route that goes through it.
    // This body does not, so without the mark the wallpaper has nothing to
    // paint against and the page renders on bare canvas.
    <div
      className="flex h-full min-h-0 flex-col"
      data-bg-target="chat"
      data-testid="squads-mobile-body"
    >
      <div className="safe-area-pt flex shrink-0 items-start justify-between gap-2 px-4 pb-2 pt-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{t("title")}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {t("summary", { total: fleet.total, live: fleet.live })}
          </p>
        </div>
        <Link
          href={settingsHref("squads")}
          aria-label={t("manageAction")}
          className="shrink-0 rounded-sm p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
          data-testid="squads-mobile-manage"
        >
          <SettingsIcon aria-hidden className="size-4" />
        </Link>
      </div>

      <Tabs
        value={tab}
        onValueChange={(next) => route.setTab(next as SquadFleetTab)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList className="mx-4 w-fit shrink-0">
          <TabsTrigger value="squads" data-testid="squads-mobile-tab-squads">
            {t("tabs.squads")}
          </TabsTrigger>
          <TabsTrigger value="runs" data-testid="squads-mobile-tab-runs">
            {t("tabs.runs")}
          </TabsTrigger>
          <TabsTrigger value="board" data-testid="squads-mobile-tab-board">
            {t("tabs.board")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="squads" className="min-h-0 flex-1">
          <SquadListPane fleet={fleet} route={route} onCreate={onCreate} />
        </TabsContent>

        <TabsContent value="runs" className="min-h-0 flex-1 overflow-y-auto p-3">
          <AgentTeamCommandCenter heading={false} />
        </TabsContent>

        <TabsContent value="board" className="min-h-0 flex-1">
          {selected ? (
            <div className="h-full min-h-0 overflow-y-auto p-3">
              <AgentTeamTasks
                teamId={selected.id}
                tasks={selectedTasks}
                teammates={selectedMembers}
              />
            </div>
          ) : (
            // The list IS "pick a Squad". Rendering it here rather than an
            // empty state pointing at another tab is the whole fix.
            <SquadListPane fleet={fleet} route={route} onCreate={onCreate} />
          )}
        </TabsContent>
      </Tabs>

      <ResponsiveDetailSheet
        open={selected !== undefined && tab === "squads"}
        onOpenChange={(open) => !open && route.setSelectedId(undefined)}
        title={selected?.name ?? ""}
        {...(selected?.description ? { description: selected.description } : {})}
      >
        {selected ? (
          <div className="space-y-3">
            <SquadInspector squadId={selected.id}>
              <TeamRunsList teamId={selected.id} />
            </SquadInspector>
            {/* Said, not hidden. A control that simply is not there reads as a
                bug, where a sentence naming where it lives does not. */}
            <p className="text-xs text-muted-foreground" data-testid="squads-mobile-configure-note">
              {t("mobile.configureOnDesktop")}
            </p>
          </div>
        ) : null}
      </ResponsiveDetailSheet>
    </div>
  )
}

export default SquadsMobileBody
