"use client"

/**
 * The centre of the agents console for each URL state (ADR-0220): an agent's
 * detail, the welcome / "new agent" chooser, blank create, builder setup, or a
 * builder conversation. Shared by the desktop console and the phone body; on a
 * phone, where there is no rail, the list itself is the root view.
 */

import { useTranslations } from "next-intl"
import { ArrowLeftIcon, Loader2Icon } from "lucide-react"
import { MobileSpotIcon } from "@/components/mobile/mobile-spot-icon"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import type { AgentsRouteState } from "@/hooks/agents/use-agents-route-state"
import type { AgentsConsoleModel } from "@/hooks/agents/use-agents-console-model"
import { AgentListPane } from "./agent-list-pane"
import { AgentDetailView } from "./detail/agent-detail-view"
import { AgentCreateChooser } from "./create/agent-create-chooser"
import { AgentBlankCreate } from "./create/agent-blank-create"
import { AgentBuilderSetup } from "./builder/agent-builder-setup"
import { AgentBuilderWorkspace } from "./builder/agent-builder-workspace"

export function AgentsView({
  route,
  model,
  compact,
}: {
  route: AgentsRouteState
  model: AgentsConsoleModel
  /** Phone layout: no rail, so the list is the root view and sub-views carry no back bar. */
  compact: boolean
}) {
  const t = useTranslations("agentsConsole")
  const { view } = route
  const agents = model.agents

  if (view.kind === "builder") {
    return (
      <AgentBuilderWorkspace
        sessionId={view.sessionId}
        onOpenAgent={(id) => route.openAgent(id)}
        onLeave={() => route.openCreate("1")}
      />
    )
  }
  if (view.kind === "create") {
    if (view.mode === "ai" || view.mode === "blank") {
      const body =
        view.mode === "ai" ? (
          <AgentBuilderSetup onStart={route.openBuilder} />
        ) : (
          <AgentBlankCreate
            catalogs={model.catalogs}
            onCreated={(agent) => route.openAgent(agent.id)}
            onCancel={() => route.openCreate("1")}
          />
        )
      // The phone body's own header already says where you are and goes back.
      if (compact) return body
      return (
        <div className="flex h-full min-h-0 flex-col" data-testid={`agents-create-${view.mode}`}>
          <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => route.openCreate("1")}
              aria-label={t("create.back")}
              data-testid="agents-create-back"
            >
              <ArrowLeftIcon className="size-4" aria-hidden />
            </Button>
            <h2 className="text-sm font-semibold">
              {view.mode === "ai" ? t("create.aiTitle") : t("create.blankTitle")}
            </h2>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
        </div>
      )
    }
    return (
      <AgentCreateChooser
        mode="create"
        agentCount={agents?.length ?? 0}
        onBlank={() => route.openCreate("blank")}
        onBuildWithAi={() => route.openCreate("ai")}
        onResumeDraft={route.openBuilder}
      />
    )
  }

  if (agents === undefined) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" aria-hidden />
        {t("loading")}
      </div>
    )
  }

  if (view.kind === "detail") {
    if (!model.selected) {
      // Deleted in another window, or a stale link: say so rather than show a
      // blank centre.
      return (
        <Empty className="h-full" data-testid="agent-not-found">
          <EmptyHeader>
            <EmptyMedia>
              <MobileSpotIcon name="characters" size={96} />
            </EmptyMedia>
            <EmptyTitle className="text-sm">{t("notFound.title")}</EmptyTitle>
            <EmptyDescription className="text-xs">{t("notFound.description")}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" variant="outline" onClick={route.openList}>
              {t("notFound.back")}
            </Button>
          </EmptyContent>
        </Empty>
      )
    }
    return (
      <AgentDetailView
        agent={model.selected}
        agents={agents}
        catalogs={model.catalogs}
        mode={view.mode}
        compact={compact}
        onModeChange={route.setMode}
        onOpenAgent={route.openAgent}
        onDeleted={route.openList}
        onStartChat={(agent) => void model.startChat(agent)}
        starting={model.startingChat}
        siblingPendingCount={model.selectedSiblingPending}
      />
    )
  }

  if (compact) {
    return (
      <AgentListPane
        agents={agents}
        summaries={model.summaries}
        query={route.query}
        source={route.source}
        sort={route.sort}
        onQueryChange={route.setQuery}
        onSourceChange={route.setSource}
        onSortChange={route.setSort}
        onSelect={(id) => route.openAgent(id)}
        onCreate={() => route.openCreate("1")}
        variant="page"
      />
    )
  }
  return (
    <AgentCreateChooser
      mode="home"
      agentCount={agents.length}
      onBlank={() => route.openCreate("blank")}
      onBuildWithAi={() => route.openCreate("ai")}
      onResumeDraft={route.openBuilder}
    />
  )
}
