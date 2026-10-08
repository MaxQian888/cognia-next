"use client"

/**
 * `/squads` on a phone.
 *
 * `FeaturePageShell` does have a mobile branch, but it collapses the left pane
 * into a Sheet behind an unlabelled glyph. For a fleet console that is
 * backwards: the list is not a sidebar here, it is the page, and the detail is
 * what should arrive on demand.
 *
 * Two levels, like every phone list: the Squads, then one Squad.
 *
 *  - Nothing selected: the list, and every Squad's runs as a second tab.
 *  - A Squad selected: its own full-screen view (`SquadDetailView`), the same
 *    component the wide pane centres, with a back button in its masthead.
 *
 * This replaces a bottom drawer over the list. The drawer held the controls
 * and readiness, while the page's Runs and Board tabs behind it went on being
 * scoped to whichever Squad was last tapped, with nothing on screen naming it.
 * The runs cockpit opens its own run detail as a sheet, so a drawer around it
 * was a sheet inside a sheet. A Board tab with no Squad selected rendered the
 * list a second time.
 *
 * Nothing about a Squad is re-modelled here. `SquadListPane`, `SquadDetailView`
 * and `AgentRunsPanel` are the components the wide pane renders, and
 * everything reads the same `useSquadFleet` projection, so a row can never say
 * one thing here and another on a desktop.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { PlusIcon, SettingsIcon, SparklesIcon, UsersIcon } from "lucide-react"

import { AgentRunsPanel } from "@/components/agent-runs/agent-runs-panel"
import { AutoComposeDialog } from "@/components/agent/workspace/auto-compose-dialog"
import { useBuiltInTeams } from "@/components/squads/built-in-teams"
import { SquadDetailView } from "@/components/squads/squad-detail-view"
import { SquadListPane } from "@/components/squads/squad-list-pane"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useCreateSquad } from "@/hooks/squads/use-create-squad"
import { useSquadFleet } from "@/hooks/squads/use-squad-fleet"
import { useSelectedSquad } from "@/hooks/squads/use-selected-squad"
import {
  resolveSquadTab,
  type SquadDetailTab,
  type SquadFleetTab,
  type SquadRouteState,
} from "@/hooks/squads/use-squad-route-state"
import { settingsHref } from "@/lib/settings/deep-link"

export interface SquadsMobileBodyProps {
  route: SquadRouteState
}

export function SquadsMobileBody({ route }: SquadsMobileBodyProps) {
  const t = useTranslations("squads.fleet")
  const fleet = useSquadFleet({ query: route.query, filter: route.filter })
  const builtIns = useBuiltInTeams()
  const selected = useSelectedSquad(route.selectedId)
  const createSquad = useCreateSquad()
  const [composeOpen, setComposeOpen] = useState(false)

  const onCreate = useCallback(() => {
    void createSquad({ name: t("newSquadName"), leadName: t("defaultLeadName") }).then((squad) =>
      route.setSelectedId(squad.id)
    )
  }, [createSquad, route, t])

  const compose = (
    <AutoComposeDialog
      open={composeOpen}
      onOpenChange={setComposeOpen}
      onComposed={(teamId) => {
        setComposeOpen(false)
        route.setSelectedId(teamId)
      }}
    />
  )

  if (route.selectedId && selected.status === "found") {
    return (
      // The shell owns `data-bg-target` for every route that goes through it.
      // This body does not, so without the mark the wallpaper has nothing to
      // paint against and the page renders on bare canvas.
      <div
        className="safe-area-pt flex h-full min-h-0 flex-col pb-[env(safe-area-inset-bottom)]"
        data-bg-target="chat"
        data-testid="squads-mobile-body"
      >
        <SquadDetailView
          squadId={route.selectedId}
          route={route}
          tab={resolveSquadTab(route.tab, { selected: true, compact: true }) as SquadDetailTab}
          onBack={() => route.setSelectedId(undefined)}
          compact
        />
        {compose}
      </div>
    )
  }

  // A link to a Squad that is gone (deleted, or from another workspace) says so
  // and offers the way back, rather than quietly showing the list with a dead
  // `?id=` still on the URL for the next share or reload to trip over.
  // Still arriving from Dexie: nothing rather than a flash of the list or of
  // "Squad unavailable" for a Squad that is a moment away.
  if (selected.status === "loading") {
    return (
      <div className="h-full" data-bg-target="chat" data-testid="squads-mobile-body">
        {compose}
      </div>
    )
  }

  if (selected.status === "missing") {
    return (
      <div
        className="safe-area-pt flex h-full min-h-0 flex-col"
        data-bg-target="chat"
        data-testid="squads-mobile-body"
      >
        <Empty className="flex-1" data-testid="squads-mobile-missing">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UsersIcon />
            </EmptyMedia>
            <EmptyTitle className="text-sm">{t("detail.missingTitle")}</EmptyTitle>
            <EmptyDescription className="text-xs">
              {t("detail.missingDescription")}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" variant="outline" onClick={() => route.setSelectedId(undefined)}>
              {t("detail.backToAll")}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  const tab = resolveSquadTab(route.tab, { selected: false, compact: true })

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-bg-target="chat"
      data-testid="squads-mobile-body"
    >
      <div className="safe-area-pt flex shrink-0 items-start justify-between gap-2 px-4 pb-2 pt-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{t("title")}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {fleet.total > 0
              ? t("summary", { total: fleet.total, live: fleet.live })
              : t("description")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9"
            onClick={() => setComposeOpen(true)}
            aria-label={t("composeCta")}
            data-testid="squads-mobile-compose"
          >
            <SparklesIcon aria-hidden className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9"
            onClick={onCreate}
            aria-label={t("createCta")}
            data-testid="squads-mobile-create"
          >
            <PlusIcon aria-hidden className="size-4" />
          </Button>
          <Button asChild variant="ghost" size="icon" className="size-9 text-muted-foreground">
            <Link
              href={settingsHref("squads")}
              aria-label={t("manageAction")}
              data-testid="squads-mobile-manage"
            >
              <SettingsIcon aria-hidden className="size-4" />
            </Link>
          </Button>
        </div>
      </div>

      <Tabs
        value={tab}
        onValueChange={(next) => route.setTab(next as SquadFleetTab)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList className="mx-4 grid w-auto shrink-0 grid-cols-2">
          <TabsTrigger value="squads" data-testid="squads-mobile-tab-squads">
            {t("tabs.squads")}
          </TabsTrigger>
          <TabsTrigger value="runs" data-testid="squads-mobile-tab-runs">
            {t("tabs.allRuns")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="squads" className="mt-2 min-h-0 flex-1">
          <SquadListPane
            fleet={fleet}
            route={route}
            onCreate={onCreate}
            builtInTeams={builtIns.teams}
            variant="page"
            emptyStyle="full"
          />
        </TabsContent>

        <TabsContent value="runs" className="mt-2 min-h-0 flex-1 overflow-hidden border-t">
          <AgentRunsPanel
            embedded
            compact
            filterKind="team"
            selectedId={route.runId}
            onSelect={(id) => route.setRunId(id ?? undefined)}
            statusGroup={route.runStatus}
            onStatusGroup={route.setRunStatus}
          />
        </TabsContent>
      </Tabs>
      {compose}
    </div>
  )
}

export default SquadsMobileBody
