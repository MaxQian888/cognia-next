"use client"

/**
 * The latency breakdown of one run: each measured phase as a labelled bar,
 * scaled to the longest one so the slice that dominates is obvious at a
 * glance. Phases are listed in the order they started; a phase the run never
 * entered is simply absent.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { formatPhaseDuration } from "@/lib/scheduler/execution-phases"
import type { TaskExecutionPhase } from "@/types/scheduler"

export function RunPhaseBreakdown({ phases }: { phases: readonly TaskExecutionPhase[] }) {
  const t = useTranslations("scheduler.runPhases")
  if (phases.length === 0) return null
  const longest = Math.max(1, ...phases.map((phase) => phase.durationMs))
  return (
    <div className="mt-3 space-y-1.5" data-testid="run-phase-breakdown">
      <p className="text-[11px] font-medium text-muted-foreground">{t("title")}</p>
      <ol className="space-y-1">
        {phases.map((phase, index) => (
          <li
            key={`${phase.name}-${index}`}
            className="grid grid-cols-[8.5rem_1fr_auto] items-center gap-2 text-[11px]"
            data-testid={`run-phase-${phase.name}`}
          >
            <span className="flex min-w-0 items-center gap-1 truncate">
              {t(`names.${phase.name}`)}
              {phase.outcome ? (
                <Badge variant="secondary" className="h-4 px-1 text-[9px]">
                  {t(`outcome.${phase.outcome}`)}
                </Badge>
              ) : null}
            </span>
            <span className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <span
                className="block h-full rounded-full bg-primary/60"
                style={{ width: `${Math.max(2, (phase.durationMs / longest) * 100)}%` }}
              />
            </span>
            <span className="font-mono tabular-nums text-muted-foreground">
              {formatPhaseDuration(phase.durationMs)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
