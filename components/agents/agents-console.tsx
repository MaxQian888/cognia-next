"use client"

/**
 * `/agents` on a desktop-width window (ADR-0220), laid out like Cognia's other
 * consoles (`/squads`, `/bots`, `/skills`): every agent in a rail on the left,
 * and in the centre the open agent, or — with none open — the ways to make
 * one. Creating keeps the rail, so the new agent lands in the list in place.
 *
 * The builder conversation is the one view without the rail: it is a chat and
 * a live form side by side, and both need the width.
 *
 * Between `md` and `lg` the shell moves the rail into a sheet; picking an agent
 * there closes it, because the pick is the whole reason it was opened.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PackageIcon, PlusIcon, SparklesIcon } from "lucide-react"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { MobileSpotIcon } from "@/components/mobile/mobile-spot-icon"
import type { AgentsRouteState } from "@/hooks/agents/use-agents-route-state"
import { useAgentsConsoleModel } from "@/hooks/agents/use-agents-console-model"
import { settingsHref } from "@/lib/settings/deep-link"
import { AgentListPane } from "./agent-list-pane"
import { AgentsView } from "./agents-view"

export function AgentsConsole({ route }: { route: AgentsRouteState }) {
  const t = useTranslations("agentsConsole")
  const model = useAgentsConsoleModel(route)
  // Only consulted below `lg`, where the shell renders the rail as a sheet.
  const [railOpen, setRailOpen] = useState(false)
  const { view } = route
  const total = model.agents?.length ?? 0
  const live = model.liveCount

  return (
    <FeaturePageShell
      storageId="agents"
      header={
        <FeaturePageHeader
          variant="management"
          icon={<MobileSpotIcon name="characters" size={32} />}
          title={t("header.title")}
          description={t("header.description")}
          summary={total > 0 ? t("header.summary", { total, live }) : undefined}
          primaryAction={{
            id: "create",
            label: t("header.new"),
            icon: PlusIcon,
            onSelect: () => route.openCreate("blank"),
            testId: "agents-new",
          }}
          secondaryActions={[
            {
              id: "build",
              label: t("header.buildWithAi"),
              icon: SparklesIcon,
              onSelect: () => route.openCreate("ai"),
              testId: "agents-build-with-ai",
            },
            {
              id: "packs",
              label: t("header.packs"),
              icon: PackageIcon,
              href: settingsHref("characters"),
              testId: "agents-packs",
            },
          ]}
          testId="agents-header"
        />
      }
      leftPane={
        view.kind === "builder"
          ? undefined
          : {
              label: t("listPane.label"),
              content: (
                <AgentListPane
                  agents={model.agents}
                  summaries={model.summaries}
                  selectedId={view.kind === "detail" ? view.id : undefined}
                  query={route.query}
                  source={route.source}
                  sort={route.sort}
                  onQueryChange={route.setQuery}
                  onSourceChange={route.setSource}
                  onSortChange={route.setSort}
                  onSelect={(id) => {
                    setRailOpen(false)
                    route.openAgent(id)
                  }}
                  onCreate={() => route.openCreate("1")}
                />
              ),
              // As a share of the window, like the Squad rail: a row carries a
              // name and a status word, and the name must stay readable.
              defaultSize: 24,
              minSize: 16,
              open: railOpen,
              onOpenChange: setRailOpen,
            }
      }
      centerClassName="min-h-0"
    >
      <AgentsView route={route} model={model} compact={false} />
    </FeaturePageShell>
  )
}
