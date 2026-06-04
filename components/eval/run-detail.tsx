"use client"

/**
 * Single-run drill-down — report header (pass rates, cost, latency, gate
 * verdict incl. failure reasons) plus the per-case scorer table fed by the
 * (previously dormant) `useEvalRunCaseResults`. Case inputs are labelled via
 * `useEvalCases` on the report's dataset.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { getRun, type EvalRunRow } from "@/lib/db/eval-runs"
import { useEvalCases, useEvalRunCaseResults } from "@/hooks/eval/use-eval-data"
import { evaluateGate } from "@/lib/ai/eval/gate"
import type { GateThresholds } from "@/types/eval/gate"

export interface RunDetailProps {
  runId: string
  gate?: GateThresholds
  onBack: () => void
}

export function RunDetail({ runId, gate, onBack }: RunDetailProps) {
  const t = useTranslations("eval.runDetail")
  const rows = useEvalRunCaseResults(runId)
  const [run, setRun] = useState<EvalRunRow | null>(null)

  useEffect(() => {
    let cancelled = false
    void getRun(runId).then((r) => {
      if (!cancelled) setRun(r ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [runId])

  const cases = useEvalCases(run?.datasetId)
  const inputByCase = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of cases) m.set(c.id, c.input)
    return m
  }, [cases])

  const gateResult = useMemo(() => (run && gate ? evaluateGate(run, gate) : undefined), [run, gate])
  const scorerIds = useMemo(() => {
    const ids = new Set<string>()
    for (const row of rows) for (const id of Object.keys(row.scores)) ids.add(id)
    return [...ids].sort()
  }, [rows])

  if (!run) return <p className="text-muted-foreground text-sm">{t("loading")}</p>

  return (
    <div className="flex flex-col gap-3" data-testid="run-detail">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" aria-label={t("back")} onClick={onBack}>
          <ArrowLeftIcon className="size-4" />
          {t("back")}
        </Button>
        <h3 className="text-base font-semibold">{run.targetLabel}</h3>
        <Badge variant="outline">{t("passAt1", { pct: Math.round(run.passAt1 * 100) })}</Badge>
        <Badge variant="outline">
          {t("passHatK", { pct: Math.round(run.passHatK * 100), k: run.k })}
        </Badge>
        <Badge variant="secondary">${run.totalCostUsd.toFixed(4)}</Badge>
        <Badge variant="secondary">{t("latency", { ms: Math.round(run.avgLatencyMs) })}</Badge>
        {gateResult && (
          <Badge variant={gateResult.passed ? "secondary" : "destructive"}>
            {gateResult.passed ? t("gatePassed") : t("gateFailed")}
          </Badge>
        )}
      </div>

      {gateResult && !gateResult.passed && (
        <ul className="text-destructive flex flex-col gap-0.5 text-xs" role="alert">
          {gateResult.failures.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("noCases")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="border p-2 text-left">{t("caseColumn")}</th>
                {scorerIds.map((id) => (
                  <th key={id} className="border p-2 text-left text-xs">
                    {id}
                  </th>
                ))}
                <th className="border p-2 text-left">{t("verdict")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="border p-2 align-top">
                    <span className="line-clamp-2">
                      {inputByCase.get(row.caseId) ?? row.caseId}
                    </span>
                  </td>
                  {scorerIds.map((id) => {
                    const s = row.scores[id]
                    return (
                      <td
                        key={id}
                        className={cn(
                          "border p-2 text-center text-xs tabular-nums",
                          s && (s.passed ? "bg-emerald-500/15" : "bg-destructive/15")
                        )}
                      >
                        {s ? s.value.toFixed(2) : "—"}
                      </td>
                    )
                  })}
                  <td
                    className={cn(
                      "border p-2 text-center",
                      row.passAt1 ? "bg-emerald-500/15" : "bg-destructive/15"
                    )}
                  >
                    {row.passAt1 ? t("pass") : t("fail")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
