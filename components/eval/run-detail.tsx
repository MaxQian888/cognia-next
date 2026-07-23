"use client"

/**
 * Single-run drill-down — report header (pass rates, cost, latency, gate
 * verdict incl. failure reasons) plus the per-case scorer table fed by the
 * (previously dormant) `useEvalRunCaseResults`. Case inputs are labelled via
 * `useEvalCases` on the report's dataset.
 *
 * Three things this view has to be honest about, all of which it used to hide:
 *  - pass rates are over GRADED cases, so the ungraded count sits next to them;
 *  - a scorer that failed on every case (judge provider down) is an alert, not
 *    a silently-excluded observation that leaves a confident-looking number;
 *  - runs written before the scoring-status change carry an inflated pass rate
 *    that is not comparable, so they are badged and their gate is withheld.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, ArrowLeftIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { getRun, type EvalRunRow } from "@/lib/db/eval-runs"
import { useEvalCases, useEvalRunCaseResults } from "@/hooks/eval/use-eval-data"
import { evaluateGate } from "@/lib/ai/eval/gate"
import { fullyErroredScorers, isLegacyScoring } from "@/lib/ai/eval/report"
import type { GateThresholds } from "@/types/eval/gate"
import type { EvalRunCaseRow } from "@/lib/db/eval-run-cases"

/** Verdict for a row, tolerating legacy rows that only have `passAt1`. */
function rowVerdict(row: EvalRunCaseRow): "pass" | "fail" | "ungraded" {
  return row.verdict ?? (row.passAt1 ? "pass" : "fail")
}

/**
 * The case prompt, expandable to what the agent actually answered and why each
 * scorer decided what it did.
 *
 * A run used to be a wall of numbers with no way to reach the underlying
 * answer — "case 7 failed" and nothing more. `<details>` rather than a dialog
 * so several cases can be open side by side while reading a run, and because
 * the repo's other eval forms already use it (jsdom-friendly, no Radix).
 */
function CaseCell({
  label,
  row,
  scorerIds,
}: {
  label: string
  row: EvalRunCaseRow
  scorerIds: string[]
}) {
  const t = useTranslations("eval.runDetail")
  const reasoned = scorerIds
    .map((id) => ({ id, score: row.scores[id] }))
    .filter((x) => x.score?.reasoning)
  const hasDetail = Boolean(row.output || row.sampleError || reasoned.length > 0)

  if (!hasDetail) return <span className="line-clamp-2">{label}</span>

  return (
    <details data-testid="case-detail">
      <summary className="cursor-pointer">
        <span className="line-clamp-2 align-middle">{label}</span>
      </summary>
      <div className="mt-2 flex flex-col gap-2 text-xs">
        {row.sampleError && (
          <p className="text-destructive" role="alert">
            {t("sampleError", { error: row.sampleError })}
          </p>
        )}
        {row.output && (
          <div>
            <p className="text-muted-foreground font-medium">{t("agentOutput")}</p>
            <p className="whitespace-pre-wrap break-words" data-testid="case-output">
              {row.output}
              {row.outputTruncated && (
                <span className="text-muted-foreground"> {t("outputTruncated")}</span>
              )}
            </p>
          </div>
        )}
        {reasoned.map(({ id, score }) => (
          <div key={id}>
            <p className="text-muted-foreground font-medium">{id}</p>
            <p className="break-words">{score!.reasoning}</p>
          </div>
        ))}
      </div>
    </details>
  )
}

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

  const legacy = run ? isLegacyScoring(run) : false
  // A legacy run's pass rate is inflated by the old scoring, so its gate
  // verdict would be equally wrong — withhold it rather than show a green tick.
  const gateResult = useMemo(
    () => (run && gate && !isLegacyScoring(run) ? evaluateGate(run, gate) : undefined),
    [run, gate]
  )
  const brokenScorers = useMemo(() => (run ? fullyErroredScorers(run) : []), [run])
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
        {!legacy && (
          <Badge variant="outline" data-testid="graded-count">
            {t("graded", {
              graded: run.gradedCaseCount ?? 0,
              ungraded: run.ungradedCaseCount ?? 0,
            })}
          </Badge>
        )}
        <Badge variant="secondary">${run.totalCostUsd.toFixed(4)}</Badge>
        <Badge variant="secondary">{t("latency", { ms: Math.round(run.avgLatencyMs) })}</Badge>
        {legacy && (
          <Badge variant="outline" data-testid="legacy-scoring">
            {t("legacyScoring")}
          </Badge>
        )}
        {gateResult && (
          <Badge variant={gateResult.passed ? "secondary" : "destructive"}>
            {gateResult.passed ? t("gatePassed") : t("gateFailed")}
          </Badge>
        )}
      </div>

      {legacy && <p className="text-muted-foreground text-xs">{t("legacyScoringHint")}</p>}

      {brokenScorers.length > 0 && (
        <p
          className="text-destructive flex items-center gap-1.5 text-xs"
          role="alert"
          data-testid="scorer-error-alert"
        >
          <AlertTriangleIcon className="size-3.5 shrink-0" />
          {t("scorersFailed", { scorers: brokenScorers.join(", ") })}
        </p>
      )}

      {!legacy && (run.ungradedCaseCount ?? 0) > 0 && (
        <p className="text-muted-foreground text-xs" data-testid="ungraded-hint">
          {t("ungradedHint", { count: run.ungradedCaseCount ?? 0 })}
        </p>
      )}

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
              {rows.map((row) => {
                const verdict = rowVerdict(row)
                return (
                  <tr key={row.id}>
                    <td className="border p-2 align-top">
                      <CaseCell
                        label={inputByCase.get(row.caseId) ?? row.caseId}
                        row={row}
                        scorerIds={scorerIds}
                      />
                    </td>
                    {scorerIds.map((id) => {
                      const s = row.scores[id]
                      // Only a real verdict gets a pass/fail colour. A
                      // not-applicable / errored / measurement observation used
                      // to render as a red 0.00, which read as "the model got
                      // this wrong" when nothing had been graded at all.
                      const scored = !s || s.status === undefined || s.status === "scored"
                      return (
                        <td
                          key={id}
                          title={
                            s?.status && !scored ? t(`status.${s.status}` as never) : undefined
                          }
                          className={cn(
                            "border p-2 text-center text-xs tabular-nums",
                            s && scored && (s.passed ? "bg-emerald-500/15" : "bg-destructive/15"),
                            s && !scored && "text-muted-foreground"
                          )}
                        >
                          {!s ? "—" : scored ? s.value.toFixed(2) : "–"}
                        </td>
                      )
                    })}
                    <td
                      className={cn(
                        "border p-2 text-center",
                        verdict === "pass" && "bg-emerald-500/15",
                        verdict === "fail" && "bg-destructive/15",
                        verdict === "ungraded" && "text-muted-foreground"
                      )}
                    >
                      {verdict === "ungraded"
                        ? t("ungraded")
                        : verdict === "pass"
                          ? t("pass")
                          : t("fail")}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
