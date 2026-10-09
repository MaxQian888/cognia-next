"use client"

/**
 * The Squad fleet on a wide pane: every Squad in a rail, and in the centre
 * either one Squad's own view or every Squad's runs.
 *
 * Deliberately runtime-first. Everything about *configuring* a Squad, its
 * roster, its governance, its bindings beyond the two readiness needs, lives in
 * Settings, where the other cross-conversation assets live. The page this
 * replaces carried both, plus a chat tab and a kanban board, and could not be
 * read as any one thing.
 *
 * Two panes, not three. A selected Squad used to add an inspector column on
 * the right, beside a runs cockpit that is itself a list and a detail, so the
 * page became rail | runs | run | inspector and every one of them was too
 * narrow for what it held. The Squad's controls and summary now head its own
 * view in the centre (`SquadDetailView`), and the cockpit gets the width.
 *
 * With nothing selected the centre is every Squad's runs, which is the one
 * fleet-wide question left once the rail lists the Squads themselves. A Board
 * tab there would only ever say "pick a Squad", so there is none.
 *
 * The board carries two plugin slots (`agent.team.task.actions`,
 * `agent.team.board.toolbar`) whose declared host stopped being rendered when
 * ADR-0140 retired `/agent-teams/workspace`. It is not folded into `/issues`:
 * both boards' headers record that crossing their two guard vocabularies (six
 * statuses against eight, `blocked` machine-only in one of them) was avoided on
 * purpose.
 *
 * This is the WIDE-PANE surface only. The phone has its own body
 * (`SquadsMobileBody`), and the list and the Squad view are shared components
 * rather than two branches of one file. Between `md` and `lg` the shell moves
 * the rail into a sheet; picking a Squad there closes it, because the pick is
 * the whole reason the sheet was opened.
 */

import { MobileSpotIcon } from "@/components/mobile/mobile-spot-icon"
import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ActivityIcon, PlusIcon, SettingsIcon, SparklesIcon } from "lucide-react"

import { AgentRunsPanel } from "@/components/agent-runs/agent-runs-panel"
import { AutoComposeDialog } from "@/components/agent/workspace/auto-compose-dialog"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
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
import { useFleetSnapshot } from "@/hooks/fleet/use-fleet-snapshot"
import { useCreateSquad } from "@/hooks/squads/use-create-squad"
import { useSquadFleet } from "@/hooks/squads/use-squad-fleet"
import { useSelectedSquad } from "@/hooks/squads/use-selected-squad"
import {
  resolveSquadTab,
  type SquadDetailTab,
  type SquadRouteState,
} from "@/hooks/squads/use-squad-route-state"
import { settingsHref } from "@/lib/settings/deep-link"

export interface SquadFleetConsoleProps {
  /**
   * The URL state, owned by the route and shared with the phone body, so a
   * link opens the same Squad and the same narrowed list on either.
   */
  route: SquadRouteState
}

export function SquadFleetConsole({ route }: SquadFleetConsoleProps) {
  const t = useTranslations("squads.fleet")
  const fleet = useSquadFleet({ query: route.query, filter: route.filter })
  const builtIns = useBuiltInTeams()
  const createSquad = useCreateSquad()
  const selected = useSelectedSquad(route.selectedId)
  const [composeOpen, setComposeOpen] = useState(false)
  // Only consulted below `lg`, where the shell renders the rail as a sheet.
  const [railOpen, setRailOpen] = useState(false)
  // `/fleet` is the live triage read of the HOST's sessions, where a parked
  // permission can be answered remotely. Its contract is `standalone: "hidden"`
  // and `companion: "remote"`, so the link is offered only where the route
  // exists: `source === "none"` is an unpaired browser, and pointing it at a
  // hidden route would be a dead end.
  const { source: fleetSource } = useFleetSnapshot()

  const onCreate = useCallback(() => {
    void createSquad({ name: t("newSquadName"), leadName: t("defaultLeadName") }).then((squad) =>
      route.setSelectedId(squad.id)
    )
  }, [createSquad, route, t])

  // The rail's copy of the route closes the sheet on a pick. The wide layout
  // ignores `open`, so this costs nothing there.
  const railRoute = useMemo<SquadRouteState>(
    () => ({
      ...route,
      setSelectedId: (id) => {
        route.setSelectedId(id)
        setRailOpen(false)
      },
    }),
    [route]
  )

  const empty = !fleet.loading && fleet.total === 0

  let center: React.ReactNode
  if (route.selectedId && selected.status === "found") {
    center = (
      <SquadDetailView
        squadId={route.selectedId}
        route={route}
        tab={resolveSquadTab(route.tab, { selected: true, compact: false }) as SquadDetailTab}
      />
    )
  } else if (selected.status === "missing") {
    // Deleted in another window, or a stale link. Saying so beats a blank
    // centre, which is what the inspector used to fall back to.
    center = (
      <Empty className="h-full" data-testid="squad-fleet-missing">
        <EmptyHeader>
          <EmptyMedia>
            <MobileSpotIcon name="agent-teams" size={96} />
          </EmptyMedia>
          <EmptyTitle className="text-sm">{t("detail.missingTitle")}</EmptyTitle>
          <EmptyDescription className="text-xs">{t("detail.missingDescription")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={() => route.setSelectedId(undefined)}>
            {t("detail.backToAll")}
          </Button>
        </EmptyContent>
      </Empty>
    )
  } else if (empty) {
    center = (
      <Empty className="h-full" data-testid="squad-fleet-onboarding">
        <EmptyHeader>
          <EmptyMedia>
            <MobileSpotIcon name="agent-teams" size={96} />
          </EmptyMedia>
          <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
          <EmptyDescription>
            {builtIns.teams.length > 0
              ? t("onboarding.descriptionWithBuiltIns", { count: builtIns.teams.length })
              : t("onboarding.description")}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row flex-wrap justify-center gap-2">
          <Button size="sm" onClick={onCreate} data-testid="squad-fleet-create">
            <PlusIcon aria-hidden className="size-4" />
            {t("createCta")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setComposeOpen(true)}
            data-testid="squad-fleet-compose-empty"
          >
            <SparklesIcon aria-hidden className="size-4" />
            {t("composeCta")}
          </Button>
        </EmptyContent>
      </Empty>
    )
  } else if (selected.status === "none" && !fleet.loading) {
    center = (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="squad-fleet-all-runs">
        <div className="shrink-0 px-4 pb-2 pt-3">
          <h2 className="text-sm font-semibold">{t("allRuns.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("allRuns.description")}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden border-t">
          {/* The canonical run cockpit, pinned to Squad runs (ADR-0169). Same
              rows, same detail pane, same `allowedActions` as `/agent-runs`. */}
          <AgentRunsPanel
            embedded
            filterKind="team"
            selectedId={route.runId}
            onSelect={(id) => route.setRunId(id ?? undefined)}
            statusGroup={route.runStatus}
            onStatusGroup={route.setRunStatus}
          />
        </div>
      </div>
    )
  } else {
    center = null
  }

  return (
    <FeaturePageShell
      storageId="squads"
      // Not `collapsibleLeftPane`: that mode pins the rail to the pixel width
      // it first rendered at (`preserve-pixel-size`), so widening the window
      // left a 230px rail beside an ever wider centre. As a share of the
      // window the rail keeps its names readable at every width.
      header={
        <FeaturePageHeader
          variant="management"
          icon={<MobileSpotIcon name="agent-teams" size={32} />}
          title={t("title")}
          description={t("description")}
          // Nothing to count yet: the centre already says "No Squads yet", and
          // a header reading "none working of 0 Squads" only repeated it badly.
          summary={
            fleet.total > 0 ? t("summary", { total: fleet.total, live: fleet.live }) : undefined
          }
          primaryAction={{
            id: "create",
            label: t("createCta"),
            icon: PlusIcon,
            onSelect: onCreate,
            testId: "squad-fleet-new",
          }}
          secondaryActions={[
            {
              id: "compose",
              label: t("composeCta"),
              icon: SparklesIcon,
              onSelect: () => setComposeOpen(true),
              testId: "squad-fleet-compose",
            },
            {
              id: "manage",
              label: t("manageAction"),
              icon: SettingsIcon,
              href: settingsHref("squads"),
              testId: "squad-fleet-manage",
            },
            ...(fleetSource === "none"
              ? []
              : [
                  {
                    id: "fleet",
                    label: t("openFleet"),
                    icon: ActivityIcon,
                    href: "/fleet",
                    testId: "squad-fleet-host-activity",
                  },
                ]),
          ]}
        />
      }
      leftPane={{
        label: t("railLabel"),
        content: (
          <SquadListPane
            fleet={fleet}
            route={railRoute}
            onCreate={onCreate}
            builtInTeams={builtIns.teams}
            variant="rail"
            // The centre carries the full empty state with both ways to make
            // a Squad; the rail only needs to say the list is empty.
            emptyStyle="quiet"
          />
        ),
        // Wider than the shell's 18% default. A row carries a name AND a status
        // badge, and the badge is `shrink-0`, so at the default the name is
        // what gives way. A list you cannot read the names in is not a list.
        defaultSize: 24,
        minSize: 16,
        open: railOpen,
        onOpenChange: setRailOpen,
      }}
      centerClassName="min-h-0"
    >
      {center}
      <AutoComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        onComposed={(teamId) => {
          setComposeOpen(false)
          route.setSelectedId(teamId)
        }}
      />
    </FeaturePageShell>
  )
}

export default SquadFleetConsole
