"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { LifecycleStatusNotice } from "@/components/agent/external-agent/lifecycle-status-notice"
import { AgentFailureNotice } from "@/components/agent/external-agent/agent-failure-notice"
import { UnsandboxedConsentAction } from "@/components/agent/external-agent/unsandboxed-consent-action"
import {
  useExternalAgentStore,
  type LifecycleExternalAgentConfig,
} from "@/stores/agent/external-agent-store"
import type { AgentReadiness } from "@/lib/ai/agent/external/agent-readiness"
import { getReadinessRemedy } from "@/lib/ai/agent/external/readiness-remedy"
import { AgentReadinessPipeline } from "./agent-readiness-pipeline"

/** One place for the readiness verdict, its remedy, and the last failed attempt. */
export function AgentStatusBlock({
  agent,
  readiness,
  isConnecting,
  onConnect,
  onEdit,
  onOpenRuntimes,
  onOpenPlugins,
  onUseSharedState,
  onEditSessionLimit,
  onAddRule,
}: {
  agent: LifecycleExternalAgentConfig
  readiness: AgentReadiness
  isConnecting: boolean
  onConnect: () => void
  onEdit: () => void
  onOpenRuntimes: () => void
  onOpenPlugins: () => void
  onUseSharedState: () => void
  onEditSessionLimit: () => void
  onAddRule: () => void
}) {
  const t = useTranslations("externalAgent.settings")
  const tReadiness = useTranslations("externalAgent.readiness")
  const failure = useExternalAgentStore((state) => state.agentFailures[agent.id])
  const clearFailure = useExternalAgentStore((state) => state.clearAgentFailure)
  const hasVerdict = Boolean(agent.lifecycleStatus && agent.lifecycleStatus !== "ready")
  const remedy = getReadinessRemedy(
    hasVerdict ? agent.lifecycleReasonCode : undefined,
    readiness.state
  )
  const handlers = {
    "open-runtimes": onOpenRuntimes,
    "edit-credentials": onEdit,
    "use-shared-state": onUseSharedState,
    "edit-session-limit": onEditSessionLimit,
  }
  const action =
    remedy === "consent" ? (
      <UnsandboxedConsentAction agent={agent} />
    ) : remedy === "open-plugins" ? (
      <Button asChild variant="outline" size="sm" className="h-auto whitespace-normal">
        <Link
          href="/plugins"
          onClick={(event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return
            event.preventDefault()
            onOpenPlugins()
          }}
        >
          {t("remedies.open-plugins")}
        </Link>
      </Button>
    ) : remedy && remedy !== "enable" && remedy !== "connect" && remedy !== "retry" ? (
      <Button
        variant="outline"
        size="sm"
        className="h-auto whitespace-normal"
        data-testid="inspector-next-action"
        onClick={handlers[remedy]}
      >
        {t(`remedies.${remedy}`)}
      </Button>
    ) : null

  return (
    <section
      className="min-w-0 space-y-3 border-b border-border/60 pb-4"
      aria-label={t("inspectorStatus")}
      data-testid="inspector-readiness"
    >
      <AgentReadinessPipeline readiness={readiness} />
      {hasVerdict ? (
        <LifecycleStatusNotice
          status={agent.lifecycleStatus}
          reasonCode={agent.lifecycleReasonCode}
          action={action}
        />
      ) : readiness.blockReason || action ? (
        <div className="flex flex-wrap items-center gap-2">
          {readiness.blockReason ? (
            <p className="min-w-0 text-xs [overflow-wrap:anywhere] text-muted-foreground">
              {readiness.blockReason}
            </p>
          ) : null}
          {action}
        </div>
      ) : null}
      {failure ? (
        <AgentFailureNotice
          failure={failure}
          className="border-0 [&_li]:[overflow-wrap:anywhere] [&_p]:[overflow-wrap:anywhere]"
          onRetry={
            readiness.state !== "disabled" && readiness.state !== "blocked" ? onConnect : undefined
          }
          retrying={isConnecting}
          onDismiss={() => clearFailure(agent.id)}
        />
      ) : null}
      {readiness.nextAction === "add-rule" ? (
        <Button
          variant="link"
          size="sm"
          className="h-auto whitespace-normal px-0"
          data-testid="inspector-next-action"
          onClick={onAddRule}
        >
          {tReadiness("actions.addRule")}
        </Button>
      ) : null}
    </section>
  )
}
