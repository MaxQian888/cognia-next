"use client"

/**
 * Per-dataset run history — consumes the (previously dormant) `useEvalRuns`
 * hook. Each row: target label, when, pass@1 / pass^k, cost, and a gate
 * verdict badge when the dataset has thresholds. Click opens {@link RunDetail}.
 */

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { useEvalRuns } from "@/hooks/eval/use-eval-data"
import { evaluateGate } from "@/lib/ai/eval/gate"
import { isLegacyScoring } from "@/lib/ai/eval/report"
import type { EvalRunRow } from "@/lib/db/eval-runs"
import type { GateThresholds } from "@/types/eval/gate"

export interface RunsListProps {
  datasetId: string
  gate?: GateThresholds
  onOpenRun: (runId: string) => void
}

/** Container: reads the dataset's runs and delegates to the presentational view. */
export function RunsList({ datasetId, gate, onOpenRun }: RunsListProps) {
  const runs = useEvalRuns(datasetId)
  return <RunsListView runs={runs} gate={gate} onOpenRun={onOpenRun} />
}

export interface RunsListViewProps {
  runs: EvalRunRow[]
  gate?: GateThresholds
  onOpenRun: (runId: string) => void
}

/** Presentational run history — data-free, so it's previewable in isolation. */
export function RunsListView({ runs, gate, onOpenRun }: RunsListViewProps) {
  const t = useTranslations("eval.runsList")

  if (runs.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("empty")}</p>
  }

  return (
    <ul className="flex flex-col gap-1" data-testid="runs-list">
      {runs.map((run) => {
        // Legacy runs carry an inflated pass rate, so their gate verdict would
        // be equally wrong — badge them and withhold it.
        const legacy = isLegacyScoring(run)
        const gateResult = gate && !legacy ? evaluateGate(run, gate) : undefined
        return (
          <li key={run.runId}>
            <button
              type="button"
              aria-label={t("openRun", { label: run.targetLabel })}
              onClick={() => onOpenRun(run.runId)}
              className="hover:bg-accent flex w-full flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-left text-sm"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">{run.targetLabel}</span>
                <span className="text-muted-foreground shrink-0 text-xs">
                  {new Date(run.createdAt).toLocaleString()}
                </span>
              </span>
              <span className="flex shrink-0 flex-wrap items-center gap-1">
                <Badge variant="outline">
                  {t("passAt1", { pct: Math.round(run.passAt1 * 100) })}
                </Badge>
                {run.k > 1 && (
                  <Badge variant="outline">
                    {t("passHatK", { pct: Math.round(run.passHatK * 100), k: run.k })}
                  </Badge>
                )}
                {!legacy && (run.ungradedCaseCount ?? 0) > 0 && (
                  <Badge variant="outline" data-testid="runs-list-ungraded">
                    {t("ungraded", { count: run.ungradedCaseCount ?? 0 })}
                  </Badge>
                )}
                <Badge variant="secondary">${run.totalCostUsd.toFixed(2)}</Badge>
                {legacy && (
                  <Badge variant="outline" data-testid="runs-list-legacy">
                    {t("legacyScoring")}
                  </Badge>
                )}
                {gateResult && (
                  <Badge variant={gateResult.passed ? "secondary" : "destructive"}>
                    {gateResult.passed ? t("gatePassed") : t("gateFailed")}
                  </Badge>
                )}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
