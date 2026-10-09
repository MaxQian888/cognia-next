"use client"

/**
 * `/agents` on a phone (ADR-0220): the same views as the desktop console in
 * one column — the list is the root, an agent's detail and the create flows
 * replace it with a back button, and the builder's chat and draft become tabs.
 */

import { useTranslations } from "next-intl"
import { ArrowLeftIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AgentsView } from "@/components/agents/agents-view"
import type { AgentsRouteState } from "@/hooks/agents/use-agents-route-state"
import { useAgentsConsoleModel } from "@/hooks/agents/use-agents-console-model"

export function AgentsMobileBody({ route }: { route: AgentsRouteState }) {
  const t = useTranslations("agentsConsole")
  const model = useAgentsConsoleModel(route)
  const { view } = route
  const atRoot = view.kind === "list"
  const back =
    view.kind === "create" && view.mode !== "1"
      ? () => route.openCreate("1")
      : view.kind === "builder"
        ? () => route.openCreate("ai")
        : view.kind === "detail" && view.mode !== "overview"
          ? () => route.setMode("overview")
          : route.openList
  // The detail's own masthead names the agent; the bar only says where you are.
  const title =
    view.kind === "list" || view.kind === "detail" ? t("header.title") : t("header.createTitle")

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agents-mobile-body">
      <header className="safe-area-pt flex shrink-0 items-center gap-2 border-b px-3 py-2">
        {atRoot ? null : (
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={back}
            aria-label={t("header.back")}
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">{title}</h1>
          {atRoot ? (
            <p className="truncate text-xs text-muted-foreground">
              {model.agents?.length
                ? t("header.count", { count: model.agents.length })
                : t("header.description")}
            </p>
          ) : null}
        </div>
        {atRoot ? (
          <Button
            size="icon"
            variant="outline"
            className="size-8"
            onClick={() => route.openCreate("1")}
            aria-label={t("header.new")}
          >
            <PlusIcon className="size-4" />
          </Button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AgentsView route={route} model={model} compact />
      </div>
    </div>
  )
}
