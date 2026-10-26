"use client"

/**
 * The run's plan as it walks it: phases (per round in sequential mode), each
 * with its steps and their state. Planned steps the run has not reached yet
 * are shown too, so a person sees how much is left.
 */

import { useTranslations } from "next-intl"
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleSlashIcon,
  Loader2Icon,
  PauseCircleIcon,
  RecycleIcon,
  XCircleIcon,
} from "lucide-react"
import { runTimeline, stepLabelParts } from "@/lib/harness/run-view"
import { formatUsd } from "@/lib/observability/format-utils"
import { cn } from "@/lib/utils"
import type {
  HarnessEvolutionRun,
  HarnessEvolutionStep,
  HarnessStepStatus,
} from "@/types/harness/evolution"

const STATUS_ICON: Record<HarnessStepStatus | "planned", typeof CheckCircle2Icon> = {
  planned: CircleDashedIcon,
  pending: CircleDashedIcon,
  running: Loader2Icon,
  succeeded: CheckCircle2Icon,
  failed: XCircleIcon,
  interrupted: PauseCircleIcon,
  skipped: CircleSlashIcon,
}

/** A step label as a person reads it ("Domain edit 2", "Rollout of aggregate 1"). */
export function useStepLabel() {
  const t = useTranslations("harnessEvolution.step")
  return (label: string): string => {
    const parts = stepLabelParts(label)
    if (parts.kind === "rollout") {
      if (!parts.of) return t("kind.rollout")
      const target = stepLabelParts(parts.of)
      if (target.kind === "rollout") return t("rolloutOf", { of: parts.of })
      return t("rolloutOf", {
        of: t(`kind.${target.kind}`, { index: target.index ?? 1 }),
      })
    }
    return t(`kind.${parts.kind}`, { index: parts.index ?? 1 })
  }
}

export interface HarnessRunTimelineProps {
  run: Pick<HarnessEvolutionRun, "config">
  steps: readonly HarnessEvolutionStep[]
  selectedLabel?: string
  onSelect: (label: string) => void
}

export function HarnessRunTimeline({
  run,
  steps,
  selectedLabel,
  onSelect,
}: HarnessRunTimelineProps) {
  const t = useTranslations("harnessEvolution")
  const labelOf = useStepLabel()
  const groups = runTimeline(run, steps)
  return (
    <ol className="flex flex-col gap-4" data-testid="harness-run-timeline">
      {groups.map((group, gi) => (
        <li key={`${group.phase}-${group.round ?? 0}-${gi}`} className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {group.round !== undefined
              ? t("timeline.phaseRound", { phase: t(`status.${group.phase}`), round: group.round })
              : t(`status.${group.phase}`)}
          </h4>
          <ul className="flex flex-col gap-1">
            {group.steps.map(({ planned, step }) => {
              const state = step?.status ?? "planned"
              const Icon = STATUS_ICON[state]
              const selected = selectedLabel === planned.label
              return (
                <li key={planned.label}>
                  <button
                    type="button"
                    disabled={!step}
                    onClick={() => onSelect(planned.label)}
                    aria-pressed={selected}
                    data-testid={`harness-step-${planned.label}`}
                    data-state={state}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm",
                      "enabled:hover:bg-accent disabled:cursor-default disabled:opacity-60",
                      selected && "border-primary bg-accent"
                    )}
                  >
                    <Icon
                      className={cn(
                        "size-4 shrink-0",
                        state === "running" && "animate-spin",
                        state === "succeeded" && "text-success",
                        state === "failed" && "text-destructive"
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">{labelOf(planned.label)}</span>
                    <span className="sr-only">{t(`stepStatus.${state}`)}</span>
                    {step?.cacheHitOf ? (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <RecycleIcon className="size-3" aria-hidden />
                        {t("timeline.reused")}
                      </span>
                    ) : null}
                    {step?.fellBack ? (
                      <span className="text-xs text-muted-foreground">
                        {t("timeline.fellBack")}
                      </span>
                    ) : step?.keptBase ? (
                      <span className="text-xs text-muted-foreground">
                        {t("timeline.keptBase")}
                      </span>
                    ) : null}
                    {step?.costUsd !== undefined && step.costUsd > 0 ? (
                      <span className="tabular-nums text-xs text-muted-foreground">
                        {formatUsd(step.costUsd)}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        </li>
      ))}
    </ol>
  )
}
