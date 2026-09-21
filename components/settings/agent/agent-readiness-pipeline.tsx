"use client"

/**
 * Agent readiness visuals — three densities of the same model
 * (`lib/ai/agent/external/agent-readiness.ts`):
 *
 *   AgentReadinessPipeline  full four-step strip for the overview board and
 *                           the inspector header
 *   AgentReadinessDots      4-dot mini pipeline for rail rows
 *   AgentStatePill          one-word state badge
 *
 * All steps/states/actions are ids in the model; the labels live under the
 * `externalAgent.readiness` i18n namespace so lib stays locale-free.
 */

import { Check, CircleSlash, Loader2, X } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type {
  AgentReadiness,
  AgentReadinessState,
  AgentReadinessStep,
  AgentReadinessStepState,
} from "@/lib/ai/agent/external/agent-readiness"

const STEP_LABEL_KEY: Record<AgentReadinessStep["id"], string> = {
  configured: "steps.configured",
  runnable: "steps.runnable",
  connected: "steps.connected",
  routed: "steps.routed",
}

const STATE_LABEL_KEY: Record<AgentReadinessState, string> = {
  disabled: "states.disabled",
  blocked: "states.blocked",
  error: "states.error",
  connecting: "states.connecting",
  connected: "states.connected",
  off: "states.off",
}

const STATE_BADGE_CLASS: Record<AgentReadinessState, string> = {
  disabled: "border-transparent bg-muted text-muted-foreground",
  blocked: "border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400",
  error: "border-transparent bg-destructive/15 text-destructive",
  connecting: "border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400",
  connected: "border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  off: "border-transparent bg-muted text-muted-foreground",
}

export function AgentStatePill({
  readiness,
  className,
}: {
  readiness: AgentReadiness
  className?: string
}) {
  const t = useTranslations("externalAgent.readiness")
  const label = readiness.blockTransient
    ? t("states.checking")
    : t(STATE_LABEL_KEY[readiness.state])
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 font-normal", STATE_BADGE_CLASS[readiness.state], className)}
      data-testid={`agent-state-${readiness.state}`}
    >
      {readiness.state === "connecting" || readiness.blockTransient ? (
        <Loader2 className="size-3 animate-spin" aria-hidden />
      ) : null}
      {label}
    </Badge>
  )
}

function stepIcon(state: AgentReadinessStepState) {
  switch (state) {
    case "done":
      return <Check className="size-3" aria-hidden />
    case "failed":
      return <X className="size-3" aria-hidden />
    case "current":
      return <Loader2 className="size-3 animate-spin" aria-hidden />
    case "off":
      return <CircleSlash className="size-3" aria-hidden />
    default:
      return null
  }
}

const STEP_DOT_CLASS: Record<AgentReadinessStepState, string> = {
  done: "border-emerald-500 bg-emerald-500 text-white",
  current: "border-amber-500 bg-amber-500/15 text-amber-600 dark:text-amber-400",
  failed: "border-destructive bg-destructive/15 text-destructive",
  todo: "border-muted-foreground/30 bg-transparent text-muted-foreground/50",
  off: "border-muted-foreground/20 bg-muted text-muted-foreground/40",
}

const STEP_TEXT_CLASS: Record<AgentReadinessStepState, string> = {
  done: "text-foreground",
  current: "text-amber-600 dark:text-amber-400",
  failed: "text-destructive",
  todo: "text-muted-foreground",
  off: "text-muted-foreground/60",
}

const CONNECTOR_CLASS: Record<AgentReadinessStepState, string> = {
  done: "bg-emerald-500",
  current: "bg-amber-500/60",
  failed: "bg-destructive/60",
  todo: "bg-muted-foreground/20",
  off: "bg-muted-foreground/15",
}

export function AgentReadinessPipeline({
  readiness,
  compact = false,
  className,
}: {
  readiness: AgentReadiness
  compact?: boolean
  className?: string
}) {
  const t = useTranslations("externalAgent.readiness")
  return (
    <ol
      className={cn("flex items-center", compact ? "gap-1" : "gap-2", className)}
      aria-label={t("pipelineLabel")}
    >
      {readiness.steps.map((step, i) => (
        <li key={step.id} className="flex items-center gap-1.5">
          {i > 0 ? (
            <span
              className={cn("h-px", compact ? "w-2" : "w-4", CONNECTOR_CLASS[step.state])}
              aria-hidden
            />
          ) : null}
          <span
            className={cn(
              "flex items-center justify-center rounded-full border",
              compact ? "size-4" : "size-5",
              STEP_DOT_CLASS[step.state]
            )}
            data-testid={`step-${step.id}-${step.state}`}
          >
            {stepIcon(step.state)}
          </span>
          {!compact ? (
            <span className={cn("text-xs whitespace-nowrap", STEP_TEXT_CLASS[step.state])}>
              {t(STEP_LABEL_KEY[step.id])}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

const MINI_DOT_CLASS: Record<AgentReadinessStepState, string> = {
  done: "bg-emerald-500",
  current: "bg-amber-500",
  failed: "bg-destructive",
  todo: "bg-muted-foreground/25",
  off: "bg-muted-foreground/15",
}

/** Four bare dots for a rail row — enough to see *where* an agent is stuck. */
export function AgentReadinessDots({
  readiness,
  className,
}: {
  readiness: AgentReadiness
  className?: string
}) {
  const t = useTranslations("externalAgent.readiness")
  return (
    <span
      className={cn("flex items-center gap-1", className)}
      role="img"
      aria-label={t("dotsLabel", {
        summary: readiness.steps
          .map((s) => `${t(STEP_LABEL_KEY[s.id])}: ${t(`stepStates.${s.state}`)}`)
          .join(", "),
      })}
    >
      {readiness.steps.map((step) => (
        <span
          key={step.id}
          className={cn("size-1.5 rounded-full", MINI_DOT_CLASS[step.state])}
          data-testid={`dot-${step.id}-${step.state}`}
        />
      ))}
    </span>
  )
}
