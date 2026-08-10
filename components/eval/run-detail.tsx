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

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangleIcon, ArrowLeftIcon, ChevronDownIcon, ScaleIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { getRun, type EvalRunRow } from "@/lib/db/eval-runs"
import { useCalibrationSets, useEvalCases, useEvalRunCaseResults } from "@/hooks/eval/use-eval-data"
import { evaluateGate } from "@/lib/ai/eval/gate"
import { fullyErroredScorers, isLegacyScoring, isPartialRun } from "@/lib/ai/eval/report"
import { buildCalibrationSeed, judgeScorerIds } from "@/lib/ai/eval/calibration/seed-from-run"
import { newCalibrationSetId, upsertCalibrationItem } from "@/lib/db/calibration-items"
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
 * answer — "case 7 failed" and nothing more. An uncontrolled Collapsible keeps
 * several cases open side by side while reading a run without requiring a
 * dialog per row.
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
    <Collapsible className="group/collapsible" data-testid="case-detail">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="h-auto w-full justify-between p-0 text-left font-normal">
          <span className="line-clamp-2 align-middle">{label}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]/collapsible:rotate-180" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent forceMount className="mt-2 flex flex-col gap-2 text-xs">
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
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Send this run's judged cases to a calibration set.
 *
 * Calibration measures whether a judge agrees with a human, but a set could
 * only be built by retyping (request, answer) pairs by hand — so nobody built
 * one and no judge's agreement was ever measured. Everything it needs is
 * already in the run now that answers and reasoning are persisted.
 */
function SeedCalibration({
  rows,
  inputByCase,
  referenceByCase,
}: {
  rows: EvalRunCaseRow[]
  inputByCase: Map<string, string>
  referenceByCase: Record<string, string>
}) {
  const t = useTranslations("eval.runDetail")
  const sets = useCalibrationSets()
  const [open, setOpen] = useState(false)
  // "" = create a new set under `newSetName`; otherwise an existing set's id.
  // Free-typing an id would recreate the collision the set model just fixed.
  const [targetSetId, setTargetSetId] = useState("")
  const [newSetName, setNewSetName] = useState("")
  const [scorerId, setScorerId] = useState("")
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ added: number; skipped: number } | null>(null)

  const judgeIds = useMemo(() => judgeScorerIds(rows), [rows])
  const effectiveScorer = scorerId || judgeIds[0] || ""

  const existing = sets.find((s) => s.setId === targetSetId)
  const resolvedName = existing?.setName ?? newSetName.trim()
  const canSeed = Boolean(targetSetId || newSetName.trim())

  const preview = useMemo(
    () =>
      effectiveScorer
        ? buildCalibrationSeed({
            setId: targetSetId || "preview",
            criterion: effectiveScorer,
            rubric: existing?.rubric ?? "",
            scorerId: effectiveScorer,
            rows,
            inputsByCase: Object.fromEntries(inputByCase),
            referencesByCase: referenceByCase,
          })
        : { items: [], skipped: [] },
    [effectiveScorer, targetSetId, existing?.rubric, rows, inputByCase, referenceByCase]
  )

  const seed = useCallback(async () => {
    if (!canSeed || preview.items.length === 0) return
    setBusy(true)
    try {
      // A brand-new set gets a fresh opaque id here, not the typed name.
      const setId = targetSetId || newCalibrationSetId()
      for (const item of preview.items) {
        await upsertCalibrationItem({ ...item, setId, setName: resolvedName })
      }
      setDone({ added: preview.items.length, skipped: preview.skipped.length })
    } finally {
      setBusy(false)
    }
  }, [canSeed, targetSetId, resolvedName, preview])

  if (judgeIds.length === 0) return null

  if (!open) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        onClick={() => setOpen(true)}
        data-testid="seed-calibration-open"
      >
        <ScaleIcon className="size-4" />
        {t("calibration.open")}
      </Button>
    )
  }

  return (
    <div
      className="motion-safe:animate-in motion-safe:fade-in flex flex-col gap-2 rounded-md border p-2"
      data-testid="seed-calibration"
    >
      <p className="text-muted-foreground text-xs">{t("calibration.hint")}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("calibration.set")}</span>
          <NativeSelect
            aria-label={t("calibration.set")}
            size="sm"
            wrapperClassName="w-full"
            value={targetSetId}
            onChange={(e) => setTargetSetId(e.target.value)}
          >
            <NativeSelectOption value="">{t("calibration.newSet")}</NativeSelectOption>
            {sets.map((s) => (
              <NativeSelectOption key={s.setId} value={s.setId}>
                {s.setName}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        {!targetSetId && (
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("calibration.newSetName")}</span>
            <Input
              aria-label={t("calibration.newSetName")}
              value={newSetName}
              onChange={(e) => setNewSetName(e.target.value)}
            />
          </label>
        )}
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("calibration.scorer")}</span>
          <NativeSelect
            aria-label={t("calibration.scorer")}
            size="sm"
            wrapperClassName="w-full"
            value={effectiveScorer}
            onChange={(e) => setScorerId(e.target.value)}
          >
            {judgeIds.map((id) => (
              <NativeSelectOption key={id} value={id}>
                {id}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      </div>
      <p className="text-muted-foreground text-xs" data-testid="seed-preview">
        {t("calibration.preview", {
          count: preview.items.length,
          skipped: preview.skipped.length,
        })}
      </p>
      {done && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400" role="status">
          {t("calibration.done", { count: done.added })}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || !canSeed || preview.items.length === 0}
          onClick={() => void seed()}
        >
          {t("calibration.seed", { count: preview.items.length })}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t("calibration.cancel")}
        </Button>
      </div>
    </div>
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
  const referenceByCase = useMemo(() => {
    const m: Record<string, string> = {}
    for (const c of cases) {
      if (c.reference?.expectedOutput) m[c.id] = c.reference.expectedOutput
    }
    return m
  }, [cases])

  const legacy = run ? isLegacyScoring(run) : false
  // A legacy run's pass rate is inflated by the old scoring, so its gate
  // verdict would be equally wrong — withhold it rather than show a green tick.
  const partial = run ? isPartialRun(run) : false
  // A run that stopped early reports rates over the cases that finished —
  // gating on that would grade the agent on an arbitrary prefix.
  const gateResult = useMemo(
    () =>
      run && gate && !isLegacyScoring(run) && !isPartialRun(run)
        ? evaluateGate(run, gate)
        : undefined,
    [run, gate]
  )
  const brokenScorers = useMemo(() => (run ? fullyErroredScorers(run) : []), [run])
  const scorerIds = useMemo(() => {
    const ids = new Set<string>()
    for (const row of rows) for (const id of Object.keys(row.scores)) ids.add(id)
    return [...ids].sort()
  }, [rows])

  if (!run) {
    return (
      <div className="flex flex-col gap-2" role="status" aria-label={t("loading")}>
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

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
        {partial && (
          <Badge variant="destructive" data-testid="run-status">
            {t(`status.${run.status}` as never)}
          </Badge>
        )}
        {gateResult && (
          <Badge variant={gateResult.passed ? "secondary" : "destructive"}>
            {gateResult.passed ? t("gatePassed") : t("gateFailed")}
          </Badge>
        )}
      </div>

      {legacy && <p className="text-muted-foreground text-xs">{t("legacyScoringHint")}</p>}
      {partial && (
        <p className="text-muted-foreground text-xs" data-testid="partial-hint">
          {t("partialHint", { done: run.caseCount })}
        </p>
      )}

      <SeedCalibration rows={rows} inputByCase={inputByCase} referenceByCase={referenceByCase} />

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
        <>
          {/* <md: per-case cards. The table below needs horizontal scrolling on a
            phone; `run-comparison-view` already degrades this way and this view
            was the odd one out. */}
          <div className="flex flex-col gap-2 md:hidden" data-testid="run-detail-cards">
            {rows.map((row) => {
              const verdict = rowVerdict(row)
              return (
                <div
                  key={row.id}
                  className="motion-safe:animate-in motion-safe:fade-in rounded-md border p-2"
                >
                  <CaseCell
                    label={inputByCase.get(row.caseId) ?? row.caseId}
                    row={row}
                    scorerIds={scorerIds}
                  />
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Badge
                      variant={
                        verdict === "pass"
                          ? "secondary"
                          : verdict === "fail"
                            ? "destructive"
                            : "outline"
                      }
                      className="text-[10px]"
                    >
                      {verdict === "ungraded"
                        ? t("ungraded")
                        : verdict === "pass"
                          ? t("pass")
                          : t("fail")}
                    </Badge>
                    {scorerIds.map((id) => {
                      const sc = row.scores[id]
                      if (!sc) return null
                      const scored = sc.status === undefined || sc.status === "scored"
                      return (
                        <Badge key={id} variant="outline" className="text-[10px] tabular-nums">
                          {id} {scored ? sc.value.toFixed(2) : "–"}
                        </Badge>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <Table className="border-collapse text-sm">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="border p-2">{t("caseColumn")}</TableHead>
                  {scorerIds.map((id) => (
                    <TableHead key={id} className="border p-2 text-xs">
                      {id}
                    </TableHead>
                  ))}
                  <TableHead className="border p-2">{t("verdict")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const verdict = rowVerdict(row)
                  return (
                    <TableRow key={row.id} className="motion-safe:animate-in motion-safe:fade-in">
                      <TableCell className="border p-2 align-top whitespace-normal">
                        <CaseCell
                          label={inputByCase.get(row.caseId) ?? row.caseId}
                          row={row}
                          scorerIds={scorerIds}
                        />
                      </TableCell>
                      {scorerIds.map((id) => {
                        const s = row.scores[id]
                        // Only a real verdict gets a pass/fail colour. A
                        // not-applicable / errored / measurement observation used
                        // to render as a red 0.00, which read as "the model got
                        // this wrong" when nothing had been graded at all.
                        const scored = !s || s.status === undefined || s.status === "scored"
                        return (
                          <TableCell
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
                          </TableCell>
                        )
                      })}
                      <TableCell
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
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  )
}
