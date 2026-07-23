"use client"

/**
 * A-vs-B(-vs-N) run comparison grid. The user picks 2+ runs; we load each
 * run's per-case verdicts (`evalRunCaseResults`), fold them with
 * {@link buildComparison}, and render a rows(cases)×cols(runs) grid coloured by
 * pass@1 with regression cells ringed and a pass@1 delta vs the baseline run.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { listCaseResults, type EvalRunCaseRow } from "@/lib/db/eval-run-cases"
import { buildComparison } from "@/lib/ai/eval/compare"
import { isLegacyScoring } from "@/lib/ai/eval/report"
import type { EvalRunRow } from "@/lib/db/eval-runs"

export interface RunComparisonViewProps {
  /** Candidate runs to compare (e.g. the dataset's recent runs). */
  runs: EvalRunRow[]
  /** Optional caseId → input text for the row labels. */
  inputsByCase?: Record<string, string>
}

export function RunComparisonView({ runs, inputsByCase = {} }: RunComparisonViewProps) {
  const t = useTranslations("eval")
  // `null` = no explicit user choice yet → derive a default (two most recent
  // runs). Deriving instead of seeding via an effect keeps the component free
  // of set-state-in-effect.
  const [override, setOverride] = useState<string[] | null>(null)
  const [resultsByRun, setResultsByRun] = useState<Record<string, EvalRunCaseRow[]>>({})

  const selected = useMemo(
    () => override ?? (runs.length >= 2 ? [runs[0].runId, runs[1].runId] : []),
    [override, runs]
  )

  // Which selection `resultsByRun` describes. While it lags `selected`, the
  // grid is still loading — it used to render "no per-case results recorded",
  // which reads as a finished, empty answer.
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const selectionKey = selected.join("|")
  const loading = selected.length >= 2 && loadedFor !== selectionKey

  useEffect(() => {
    let cancelled = false
    void Promise.all(selected.map((id) => listCaseResults(id))).then((lists) => {
      if (cancelled) return
      const next: Record<string, EvalRunCaseRow[]> = {}
      selected.forEach((id, i) => {
        next[id] = lists[i]
      })
      setResultsByRun(next)
      setLoadedFor(selectionKey)
    })
    return () => {
      cancelled = true
    }
  }, [selected, selectionKey])

  const selectedReports = useMemo(
    () => selected.map((id) => runs.find((r) => r.runId === id)).filter(Boolean) as EvalRunRow[],
    [selected, runs]
  )
  const comparison = useMemo(
    () => buildComparison(selectedReports, resultsByRun, inputsByCase),
    [selectedReports, resultsByRun, inputsByCase]
  )

  // Runs from before and after the scoring-status change are not comparable:
  // the legacy ones counted measurement-only scorers as passes, so a "drop"
  // across the boundary is the fix landing, not a regression.
  const mixedScoring = useMemo(() => {
    if (selectedReports.length < 2) return false
    const legacy = selectedReports.filter(isLegacyScoring).length
    return legacy > 0 && legacy < selectedReports.length
  }, [selectedReports])

  const toggle = (runId: string) =>
    setOverride((cur) => {
      const base = cur ?? selected
      return base.includes(runId) ? base.filter((id) => id !== runId) : [...base, runId]
    })

  return (
    <div className="flex flex-col gap-3" data-testid="run-comparison-view">
      <div className="flex flex-wrap gap-2">
        {runs.map((r) => (
          <label key={r.runId} className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(r.runId)}
              onChange={() => toggle(r.runId)}
              aria-label={t("compare.selectRun", { label: r.targetLabel })}
            />
            <span>{r.targetLabel}</span>
            <Badge variant="outline" className="text-[10px]">
              {Math.round(r.passAt1 * 100)}%
            </Badge>
          </label>
        ))}
      </div>

      {mixedScoring && (
        <p className="text-destructive text-xs" role="alert" data-testid="mixed-scoring-warning">
          {t("compare.mixedScoring")}
        </p>
      )}

      {selected.length < 2 ? (
        <p className="text-muted-foreground text-sm">{t("compare.pickTwo")}</p>
      ) : loading ? (
        <div className="flex flex-col gap-2" role="status" aria-label={t("compare.loading")}>
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : comparison.rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("compare.noCases")}</p>
      ) : (
        <>
          {/* <md: per-case cards (the table below is unusable on small screens) */}
          <div className="flex flex-col gap-2 md:hidden" data-testid="compare-cards">
            {comparison.rows.map((row) => (
              <div key={row.caseId} className="rounded-md border p-2">
                <p className="line-clamp-2 text-sm">{row.input || row.caseId}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {row.cells.map((cell) => {
                    const run = runs.find((r) => r.runId === cell.runId)
                    return (
                      <Badge
                        key={cell.runId}
                        variant={cell.passAt1 ? "secondary" : "destructive"}
                        className={cn("text-[10px]", cell.regression && "ring-destructive ring-2")}
                      >
                        {run?.targetLabel ?? cell.runId}:{" "}
                        {cell.passAt1 ? t("compare.pass") : t("compare.fail")}
                      </Badge>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className="border p-2 text-left">{t("compare.case")}</th>
                  {comparison.runIds.map((id) => {
                    const run = runs.find((r) => r.runId === id)
                    return (
                      <th key={id} className="border p-2 text-left">
                        {run?.targetLabel ?? id}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {comparison.rows.map((row) => (
                  <tr key={row.caseId}>
                    <td className="border p-2 align-top">
                      <span className="line-clamp-2">{row.input || row.caseId}</span>
                    </td>
                    {row.cells.map((cell, i) => (
                      <td
                        key={cell.runId}
                        className={cn(
                          "border p-2 text-center",
                          cell.passAt1 ? "bg-emerald-500/15" : "bg-destructive/15",
                          cell.regression && "ring-2 ring-destructive ring-inset"
                        )}
                        data-regression={cell.regression ? "true" : undefined}
                      >
                        <span>{cell.passAt1 ? t("compare.pass") : t("compare.fail")}</span>
                        {i > 0 && typeof cell.delta === "number" && cell.delta !== 0 && (
                          <span className="text-muted-foreground ml-1 text-xs">
                            {cell.delta > 0 ? "▲" : "▼"}
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
