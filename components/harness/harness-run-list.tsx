"use client"

/** An agent's Harness Evolution runs, newest first. */

import { useFormatter, useTranslations } from "next-intl"
import { formatUsd } from "@/lib/observability/format-utils"
import { cn } from "@/lib/utils"
import type { HarnessEvolutionRun } from "@/types/harness/evolution"
import { HarnessRunStatusBadge } from "./harness-run-status-badge"

export interface HarnessRunListProps {
  runs: readonly HarnessEvolutionRun[]
  selectedId?: string
  onSelect: (runId: string) => void
  /** Show which agent each run improves (lists that span agents). */
  showAgent?: boolean
}

export function HarnessRunList({
  runs,
  selectedId,
  onSelect,
  showAgent = false,
}: HarnessRunListProps) {
  const t = useTranslations("harnessEvolution")
  const format = useFormatter()
  if (runs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="harness-run-list-empty">
        {t("runList.empty")}
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-1.5" data-testid="harness-run-list">
      {runs.map((run) => (
        <li key={run.id}>
          <button
            type="button"
            onClick={() => onSelect(run.id)}
            aria-current={selectedId === run.id ? "true" : undefined}
            aria-label={t("runList.open", { title: run.task.title })}
            className={cn(
              "flex w-full flex-col gap-1 rounded-md border p-2.5 text-left hover:bg-accent",
              selectedId === run.id && "border-primary bg-accent"
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-medium">{run.task.title}</span>
              <HarnessRunStatusBadge status={run.status} />
            </span>
            <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              {showAgent ? <span>{run.characterName}</span> : null}
              <span>{t(`trigger.${run.trigger}`)}</span>
              <span>
                {format.dateTime(run.createdAt, { dateStyle: "short", timeStyle: "short" })}
              </span>
              <span className="tabular-nums">
                {formatUsd(run.ledger.costUsd)}
                {run.ledger.costUnknown ? "+" : ""}
              </span>
              {run.decision ? (
                <span>
                  {run.decision.outcome === "adopt"
                    ? t("runList.improved")
                    : t("runList.keptCurrent")}
                </span>
              ) : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
